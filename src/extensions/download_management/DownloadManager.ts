import { DataInvalid, HTTPError, ProcessCanceled, UserCanceled } from '../../util/CustomErrors';
import * as fs from '../../util/fs';
import { log } from '../../util/log';
import { countIf, INVALID_FILENAME_RE, truthy } from '../../util/util';
import { IChunk } from './types/IChunk';
import { IDownloadJob } from './types/IDownloadJob';
import { IDownloadResult } from './types/IDownloadResult';
import { ProgressCallback } from './types/ProgressCallback';
import { IProtocolHandlers } from './types/ProtocolHandlers';

import makeThrottle from './util/throttle';

import FileAssembler from './FileAssembler';
import SpeedCalculator from './SpeedCalculator';

import Promise from 'bluebird';
import * as contentDisposition from 'content-disposition';
import * as contentType from 'content-type';
import { remote } from 'electron';
import * as http from 'http';
import * as https from 'https';
import * as _ from 'lodash';
import * as path from 'path';
import * as stream from 'stream';
import * as url from 'url';
import * as zlib from 'zlib';

// assume urls are valid for at least 5 minutes
const URL_RESOLVE_EXPIRE_MS = 1000 * 60 * 5;
// don't follow redirects arbitrarily long
const MAX_REDIRECT_FOLLOW = 2;

export type RedownloadMode = 'always' | 'never' | 'ask' | 'replace';

export class AlreadyDownloaded extends Error {
  private mFileName: string;
  private mId: string;
  constructor(fileName: string) {
    super('File already downloaded');
    Error.captureStackTrace(this, this.constructor);

    this.name = this.constructor.name;
    this.mFileName = fileName;
  }

  public get fileName(): string {
    return this.mFileName;
  }

  public get downloadId() {
    return this.mId;
  }

  public set downloadId(id: string) {
    this.mId = id;
  }
}

export class DownloadIsHTML extends Error {
  private mUrl: string;
  constructor(inputUrl: string) {
    super('');
    this.name = this.constructor.name;
    this.mUrl = inputUrl;
  }

  public get url() {
    return this.mUrl;
  }
}

function isHTMLHeader(headers: http.IncomingHttpHeaders) {
  return (headers['content-type'] !== undefined)
    && (headers['content-type'].toString().startsWith('text/html'));
}

interface IHTTP {
  request: (options: https.RequestOptions | string | URL,
            callback?: (res: http.IncomingMessage) => void) => http.ClientRequest;
  Agent: typeof http.Agent;
}

interface IRunningDownload {
  id: string;
  fd?: number;
  error: boolean;
  urls: string[];
  resolvedUrls: () => Promise<string[]>;
  origName: string;
  tempName: string;
  finalName?: Promise<string>;
  lastProgressSent: number;
  received: number;
  started: Date;
  size?: number;
  headers?: any;
  assembler?: FileAssembler;
  assemblerProm?: Promise<FileAssembler>;

  redownload: RedownloadMode;
  chunks: IDownloadJob[];
  chunkable: boolean;
  promises: Array<Promise<any>>;
  progressCB?: ProgressCallback;
  finishCB: (res: IDownloadResult) => void;
  failedCB: (err) => void;
}

type FinishCallback = (paused: boolean) => void;

/**
 * a download worker. A worker is started to download one chunk of a file,
 * they are currently not reused.
 *
 * @class DownloadWorker
 */
class DownloadWorker {
  private static BUFFER_SIZE = 256 * 1024;
  private static BUFFER_SIZE_CAP = 4 * 1024 * 1024;
  private mJob: IDownloadJob;
  private mRequest: http.ClientRequest;
  private mProgressCB: (bytes: number) => void;
  private mFinishCB: FinishCallback;
  private mHeadersCB: (headers: any) => void;
  private mUserAgent: string;
  private mBuffers: Buffer[] = [];
  private mDataHistory: Array<{ time: number, size: number }> = [];
  private mEnded: boolean = false;
  private mResponse: http.IncomingMessage;
  private mWriting: boolean = false;
  private mRestart: boolean = false;
  private mRedirected: boolean = false;
  private mRedirectsFollowed: number = 0;
  private mThrottle: () => stream.Transform;

  constructor(job: IDownloadJob,
              progressCB: (bytes: number) => void,
              finishCB: FinishCallback,
              headersCB: (headers: any) => void,
              userAgent: string,
              throttle: () => stream.Transform) {
    this.mProgressCB = progressCB;
    this.mFinishCB = finishCB;
    this.mHeadersCB = headersCB;
    this.mJob = job;
    this.mUserAgent = userAgent;
    this.mThrottle = throttle;
    job.url()
      .then(jobUrl => {
        this.assignJob(job, jobUrl);
      })
      .catch(err => {
        this.handleError(err);
      });
  }

  public assignJob(job: IDownloadJob, jobUrl: string) {
    this.mDataHistory = [];
    log('debug', 'requesting range', { id: job.workerId, offset: job.offset, size: job.size });
    if (job.size <= 0) {
      // early out if the job status didn't match the range
      this.handleComplete();
      return;
    }

    if (jobUrl === undefined) {
      this.handleError(new ProcessCanceled('No URL found for this download'));
      return;
    }

    try {
      remote.getCurrentWebContents().session.cookies.get({ url: jobUrl })
        .then(cookies => {
          this.startDownload(job, jobUrl, cookies);

        })
        .catch(err => {
          log('error', 'failed to retrieve cookies', err.message);
        });
    } catch (err) {
      log('error', 'failed to retrieve cookies', err.message);
      this.startDownload(job, jobUrl, []);
    }
  }

  public cancel() {
    this.abort(false);
  }

  public pause() {
    if (this.abort(true)) {
      if (this.mResponse !== undefined) {
        this.mResponse.pause();
      }
    }
  }

  public restart() {
    this.mResponse.removeAllListeners('error');
    this.mRequest.abort();
    this.mRestart = true;
  }

  private startDownload(job: IDownloadJob, jobUrl: string, cookies: Electron.Cookie[]) {
    let parsed: url.UrlWithStringQuery;
    let referer: string;
    try {
      const [urlIn, refererIn] = jobUrl.split('<');
      // at some point in the past we'd encode the uri here which apparently led to double-encoded
      // uris. Then we'd decode it which led to the request failing if there were characters in
      // the url that required encoding.
      // Since all that was tested at some point I'm getting the feeling it's inconsistent in
      // the callers whether the url is encoded or not
      parsed = url.parse(urlIn);
      referer = refererIn;
      jobUrl = urlIn;
    } catch (err) {
      this.handleError(new Error('No valid URL for this download'));
      return;
    }

    const lib: IHTTP = parsed.protocol === 'https:' ? https : http;

    try {
      const headers = {
          Range: `bytes=${job.offset}-${job.offset + job.size}`,
          'User-Agent': this.mUserAgent,
          'Accept-Encoding': 'gzip, deflate',
          Cookie: (cookies || []).map(cookie => `${cookie.name}=${cookie.value}`),
        };
      if (referer !== undefined) {
        headers['Referer'] = referer;
      }
      this.mRequest = lib.request({
        method: 'GET',
        protocol: parsed.protocol,
        port: parsed.port,
        hostname: parsed.hostname,
        path: parsed.path,
        headers,
        agent: false,
      }, (res) => {
        log('debug', 'downloading from',
          { address: `${res.connection.remoteAddress}:${res.connection.remotePort}` });
        this.mResponse = res;
        this.handleResponse(res, encodeURI(decodeURI(jobUrl)));
        let str: stream.Readable = res;

        str = str.pipe(this.mThrottle());

        switch (res.headers['content-encoding']) {
          case 'gzip':
            str = str.pipe(zlib.createGunzip());
            break;
          case 'deflate':
            str = str.pipe(zlib.createInflate());
            break;
        }

        str
          .on('data', (data: Buffer) => {
            this.handleData(data, str);
          })
          .on('error', err => this.handleError(err))
          .on('end', () => {
            if (!this.mRedirected) {
              this.handleComplete(str);
            }
            this.mRequest.abort();
          });
      });

      this.mRequest
        .on('error', (err) => {
          this.handleError(err);
        })
        .end();
    } catch (err) {
      this.handleError(err);
    }
  }

  private handleError(err) {
    if (this.mEnded) {
      // don't report errors again
      return;
    }
    log('warn', 'chunk error', { id: this.mJob.workerId, err: err.message, ended: this.mEnded });
    if (this.mJob.errorCB !== undefined) {
      this.mJob.errorCB(err);
    }
    if (this.mRequest !== undefined) {
      this.mRequest.abort();
    }
    if ((['ESOCKETTIMEDOUT', 'ECONNRESET'].indexOf(err.code) !== -1)
        && !this.mEnded
        && (this.mDataHistory.length > 0)) {
      // as long as we made progress on this chunk, retry
      this.mJob.url().then(jobUrl => {
        this.assignJob(this.mJob, jobUrl);
      })
      .catch(innerErr => {
        this.handleError(innerErr);
      });
    } else {
      this.mEnded = true;
      this.mFinishCB(false);
    }
  }

  private abort(paused: boolean): boolean {
    if (this.mEnded) {
     return false;
    }
    if (this.mRequest !== undefined) {
      this.mRequest.abort();
    }
    this.mEnded = true;
    this.mFinishCB(paused);
    return true;
  }

  private handleHTML(inputUrl: string) {
    this.abort(false);
    if (this.mJob.errorCB !== undefined) {
      this.mJob.errorCB(new DownloadIsHTML(inputUrl));
    }
  }

  private handleComplete(str?: stream.Readable) {
    if (this.mEnded) {
      log('debug', 'chunk completed but can\'t write it anymore', JSON.stringify(this.mJob));
      return;
    }
    log('info', 'chunk completed', {
      id: this.mJob.workerId,
      numBuffers: this.mBuffers.length,
    });
    this.writeBuffer(str)
      .then(() => {
        if (this.mRestart && (this.mJob.size > 0)) {
          this.mRestart = false;
          this.mJob.url().then(jobUrl => {
            this.assignJob(this.mJob, jobUrl);
          })
            .catch(err => {
              this.handleError(err);
            });
        } else {
          if (this.mJob.completionCB !== undefined) {
            this.mJob.completionCB();
          }
          this.abort(false);
        }
      })
      .catch(UserCanceled, () => null)
      .catch(ProcessCanceled, () => null)
      .catch(err => this.handleError(err));
  }

  private handleResponse(response: http.IncomingMessage, jobUrl: string) {
    // we're not handling redirections here. For one thing it may be undesired by the user
    // plus there might be a javascript redirect which we can't handle here anyway.
    // Instead we display the website as a download with a button where the user can open the
    // it. If it contains any redirect, the browser window will follow it and initiate a
    // download.
    if (response.statusCode >= 300) {
      if (([301, 302, 307, 308].indexOf(response.statusCode) !== -1)
          && (this.mRedirectsFollowed < MAX_REDIRECT_FOLLOW)) {
        const newUrl = url.resolve(jobUrl, response.headers['location'] as string);
        log('info', 'redirected', { newUrl, loc: response.headers['location'] });
        this.mJob.url = () => Promise.resolve(newUrl);
        this.mRedirected = true;

        // delay the new request a bit to ensure the old request is completely settled
        // TODO: this is ugly and shouldn't be necessary if we made sure no state was neccessary to
        //   shut down the old connection
        setTimeout(() => {
          ++this.mRedirectsFollowed;
          this.mRedirected = false;
          // any data we may have gotten with the old reply is useless
          this.mJob.size += this.mJob.received;
          this.mJob.confirmedSize = this.mJob.size;
          this.mJob.received
            = this.mJob.offset
            = this.mJob.confirmedReceived
            = this.mJob.confirmedOffset
            = 0;
          this.mJob.state = 'running';
          this.mEnded = false;
          this.assignJob(this.mJob, newUrl);
        }, 100);
      } else {
        this.handleError(new HTTPError(response.statusCode, response.statusMessage, jobUrl));
      }
      return;
    }

    this.mHeadersCB(response.headers);

    if (isHTMLHeader(response.headers)) {
      this.handleHTML(jobUrl);
      return;
    }

    const chunkable = 'content-range' in response.headers;

    log('debug', 'retrieving range',
        { id: this.mJob.workerId, range: response.headers['content-range'] || 'full' });
    if (this.mJob.responseCB !== undefined) {
      const chunkSize: number = (response.headers['content-length'] !== undefined)
        ? parseInt(response.headers['content-length'] as string, 10)
        : -1;

      let fileSize = chunkSize;
      if (chunkable) {
        const rangeExp: RegExp = /bytes (\d)*-(\d*)\/(\d*)/i;
        const sizeMatch: string[] = (response.headers['content-range'] as string).match(rangeExp);
        if (sizeMatch.length > 1) {
          fileSize = parseInt(sizeMatch[3], 10);
        }
      } else {
        log('debug', 'download doesn\'t support partial requests');
        // download can't be resumed so the returned data will start at 0
        this.mJob.offset = 0;
      }
      if (chunkSize !== this.mJob.size) {
        // on the first request it's possible we requested more than the file size if
        // the file is smaller than the minimum size for chunking or - if the file isn't chunkable -
        // the request may be larger than what we requested initially.
        // offset should always be 0 here
        this.mJob.confirmedSize = this.mJob.size = chunkSize;
      }

      let fileName;
      if ('content-disposition' in response.headers) {
        let cd: string = response.headers['content-disposition'] as string;
        // the content-disposition library can't deal with trailing semi-colon so
        // we have to remove it before parsing
        // see https://github.com/jshttp/content-disposition/issues/19
        if (cd[cd.length - 1] === ';') {
          cd = cd.substring(0, cd.length - 1);
        }
        if (cd.startsWith('filename')) {
          cd = 'attachment;' + cd;
        }
        try {
          const disposition = contentDisposition.parse(cd);
          if (truthy(disposition.parameters['filename'])) {
            fileName = disposition.parameters['filename'];
          }
          log('debug', 'got file name', fileName);
        } catch (err) {
          log('warn', 'failed to parse content disposition', {
            'content-disposition': cd, message: err.message });
        }
      }
      this.mJob.responseCB(fileSize, fileName, chunkable);
    }
  }

  private mergeBuffers(): Buffer {
    const res = Buffer.concat(this.mBuffers);
    this.mBuffers = [];
    return res;
  }

  private get bufferLength(): number {
    return this.mBuffers.reduce((prev, iter) => prev + iter.length, 0);
  }

  private doWriteBuffer(buf: Buffer): Promise<void> {
    const len = buf.length;
    const res = this.mJob.dataCB(this.mJob.offset, buf)
      .then(() => {
        this.mJob.confirmedReceived += len;
        this.mJob.confirmedOffset += len;
        this.mJob.confirmedSize -= len;
      });

    // need to update immediately, otherwise chunks might overwrite each other
    this.mJob.received += len;
    this.mJob.offset += len;
    this.mJob.size -= len;
    return res;
  }

  private writeBuffer(str: stream.Readable): Promise<void> {
    if (this.mBuffers.length === 0) {
      return Promise.resolve();
    }

    let merged: Buffer;

    try {
      merged = this.mergeBuffers();
    } catch (err) {
      // we failed to merge the smaller buffers, probably a memory issue.
      log('warn', 'failed to merge buffers', { sizes: this.mBuffers.map(buf => buf.length) });
      // let's try to write the buffers individually
      const bufs = this.mBuffers;
      this.mBuffers = [];
      str?.pause?.();
      return Promise.mapSeries(bufs, buf => this.doWriteBuffer(buf))
        .then(() => {
          str?.resume?.();
        });
    }

    return this.doWriteBuffer(merged);
  }

  private handleData(data: Buffer, str: stream.Readable) {
    if (this.mEnded || ['paused', 'finished'].includes(this.mJob.state)) {
      log('debug', 'got data after ended',
          { workerId: this.mJob.workerId, ended: this.mEnded, aborted: this.mRequest.aborted });
      this.mRequest.abort();
      return;
    }

    if (this.mRedirected) {
      // ignore message body when we were redirected
      return;
    }

    this.mDataHistory.push({ time: Date.now(), size: data.byteLength });
    this.mBuffers.push(data);

    const bufferLength = this.bufferLength;
    if (bufferLength >= DownloadWorker.BUFFER_SIZE) {
      if (!this.mWriting) {
        this.mWriting = true;
        this.writeBuffer(str)
          .catch(UserCanceled, () => null)
          .catch(ProcessCanceled, () => null)
          .catch(err => {
            this.handleError(err);
          })
          .then(() => {
            this.mWriting = false;
            if (this.mResponse.isPaused()) {
              this.mResponse.resume();
            }
          });
        this.mProgressCB(bufferLength);
      } else if (bufferLength >= DownloadWorker.BUFFER_SIZE_CAP) {
        // throttle the download because we can't process input fast enough and we
        // risk the memory usage to escalate
        this.mResponse.pause();
      }
    }
  }
}

/**
 * manages downloads
 *
 * @class DownloadManager
 */
class DownloadManager {
  private mMinChunkSize: number;
  private mMaxWorkers: number;
  private mMaxChunks: number;
  private mDownloadPath: string;
  private mBusyWorkers: { [id: number]: DownloadWorker } = {};
  private mSlowWorkers: { [id: number]: number } = {};
  private mQueue: IRunningDownload[] = [];
  private mNextId: number = 0;
  private mSpeedCalculator: SpeedCalculator;
  private mUserAgent: string;
  private mProtocolHandlers: IProtocolHandlers;
  private mResolveCache: { [url: string]: { time: number, urls: string[] } } = {};
  private mFileExistsCB: (fileName: string) => Promise<boolean>;
  private mThrottle: () => stream.Transform;

  /**
   * Creates an instance of DownloadManager.
   *
   * @param {string} downloadPath default path to download to if the enqueue command doesn't
   *                 specify otherwise
   * @param {number} maxWorkers maximum number of workers downloading data at once. should be bigger
   *                            than maxChunks
   * @param {number} maxChunks maximum number of chunks per file being downloaded at once
   *
   * @memberOf DownloadManager
   */
  constructor(downloadPath: string, maxWorkers: number, maxChunks: number,
              speedCB: (speed: number) => void, userAgent: string,
              protocolHandlers: IProtocolHandlers,
              maxBandwidth: () => number) {
    // hard coded chunk size but I doubt this needs to be customized by the user
    this.mMinChunkSize = 20 * 1024 * 1024;
    this.mDownloadPath = downloadPath;
    this.mMaxWorkers = maxWorkers;
    this.mMaxChunks = maxChunks;
    this.mUserAgent = userAgent;
    this.mSpeedCalculator = new SpeedCalculator(5, speedCB);
    this.mProtocolHandlers = protocolHandlers;
    this.mThrottle = () => makeThrottle(maxBandwidth);
  }

  public setFileExistsCB(cb: (fileName: string) => Promise<boolean>) {
    this.mFileExistsCB = cb;
  }

  public setDownloadPath(downloadPath: string) {
    this.mDownloadPath = downloadPath;
  }

  public setMaxConcurrentDownloads(maxConcurrent: number) {
    this.mMaxWorkers = maxConcurrent;
  }

  /**
   * enqueues a download
   *
   * @param {string[]} urls
   * @param {(received: number, total: number) => void} progressCB
   * @param {string} [destinationPath]
   * @returns {Promise<string>}
   *
   * @memberOf DownloadManager
   */
  public enqueue(id: string, urls: string[],
                 fileName: string,
                 progressCB: ProgressCallback,
                 destinationPath?: string,
                 redownload: RedownloadMode = 'ask'): Promise<IDownloadResult> {
    if (urls.length === 0) {
      return Promise.reject(new Error('No download urls'));
    }
    log('info', 'queueing download', id);
    let nameTemplate: string;
    let baseUrl: string;
    try {
      baseUrl = urls[0].split('<')[0];
      nameTemplate = fileName || decodeURI(path.basename(url.parse(baseUrl).pathname));
    } catch (err) {
      return Promise.reject(new DataInvalid(`failed to parse url "${baseUrl}"`));
    }
    const destPath = destinationPath || this.mDownloadPath;
    let download: IRunningDownload;
    return fs.ensureDirAsync(destPath)
      .then(() => this.unusedName(destPath, nameTemplate || 'deferred', redownload))
      .then((filePath: string) =>
        new Promise<IDownloadResult>((resolve, reject) => {
          download = {
            id,
            origName: nameTemplate,
            tempName: filePath,
            finalName: (fileName !== undefined)
              ? Promise.resolve(path.join(destPath, path.basename(filePath))) : undefined,
            error: false,
            urls,
            redownload,
            resolvedUrls: this.resolveUrls(urls),
            started: new Date(),
            lastProgressSent: 0,
            received: 0,
            chunks: [],
            chunkable: undefined,
            progressCB,
            finishCB: resolve,
            failedCB: (err) => {
              reject(err);
            },
            promises: [],
          };
          download.chunks.push(this.initChunk(download));
          this.mQueue.push(download);
          progressCB(0, undefined,
                     download.chunks.map(this.toStoredChunk), download.chunkable,
                     undefined, filePath);
          this.tickQueue();
        }))
      .finally(() => (download !== undefined) && (download.assembler !== undefined)
          ? download.assembler.close()
          : Promise.resolve());
  }

  public resume(id: string,
                filePath: string,
                urls: string[],
                received: number,
                size: number,
                started: number,
                chunks: IChunk[],
                progressCB: ProgressCallback): Promise<IDownloadResult> {
    return new Promise<IDownloadResult>((resolve, reject) => {
      const download: IRunningDownload = {
        id,
        origName: path.basename(filePath),
        tempName: filePath,
        error: false,
        urls,
        resolvedUrls: this.resolveUrls(urls),
        lastProgressSent: 0,
        received,
        // we don't know what this was set to initially but going to assume that it was always
        // or the user said yes, otherwise why is this resumable and not canceled?
        redownload: 'always',
        size,
        started: new Date(started),
        chunks: [],
        chunkable: undefined,
        progressCB,
        finishCB: resolve,
        failedCB: (err) => {
          reject(err);
        },
        promises: [],
      };
      const isPending = received === 0;
      download.chunks = (chunks || [])
        .map((chunk, idx) => this.toJob(download, chunk, isPending && (idx === 0)));
      if (download.chunks.length > 0) {
        download.chunks[0].errorCB = (err) => { this.cancelDownload(download, err); };
        this.mQueue.push(download);
        this.tickQueue();
      } else {
        return reject(new ProcessCanceled('No unfinished chunks'));
      }
    });
  }

  /**
   * cancels a download. This stops the download but doesn't remove the file
   * This call does not wait for the download to actually be stopped, it merely
   * sends the signal to stop it
   *
   * @param {string} id
   *
   * @memberOf DownloadManager
   */
  public stop(id: string) {
    const download: IRunningDownload = this.mQueue.find(
      (value: IRunningDownload) => value.id === id);
    if (download === undefined) {
      log('warn', 'failed to cancel download, not found', { id });
      return;
    }
    log('info', 'stopping download', { id });

    // first, make sure not-yet-started chunks are paused, otherwise
    // they might get started as we stop running chunks as that frees
    // space in the queue
    download.chunks.forEach((chunk: IDownloadJob) => {
      if (chunk.state === 'init') {
        chunk.state = 'finished';
      }
    });

    if (download.chunks.find(chunk => chunk.state !== 'finished') !== undefined) {
      // stop running workers
      download.chunks.forEach((chunk: IDownloadJob) => {
        if ((chunk.state === 'running')
            && (this.mBusyWorkers[chunk.workerId] !== undefined)) {
          this.mBusyWorkers[chunk.workerId].cancel();
        }
      });
    } else {
      // None of the chunks have ever started downloading; this is valid if
      //  the user had queued this download and it never started off.
      //  In this case we can cancel the download directly as there are no
      //  running workers!
      download.failedCB(new UserCanceled());
    }

    // remove from queue
    this.mQueue = this.mQueue.filter(
      (value: IRunningDownload) => value.id !== id);
  }

  public pause(id: string) {
    const download: IRunningDownload = this.mQueue.find(
      (value: IRunningDownload) => value.id === id);
    if (download === undefined) {
      // this indicates the download isn't queued, so effectively it's already
      // paused
      log('warn', 'failed to pause download, not found', { id });
      return undefined;
    }
    log('info', 'pause download', { id });

    const unfinishedChunks: IChunk[] = [];

    // first, make sure not-yet-started chunks are paused, otherwise
    // they might get started as we stop running chunks as that frees
    // space in the queue
    download.chunks.forEach((chunk: IDownloadJob) => {
      if (chunk.state === 'init') {
        chunk.state = 'paused';
      }
    });

    // stop running workers
    download.chunks.forEach((chunk: IDownloadJob) => {
      if (['running', 'paused'].includes(chunk.state) && (chunk.size > 0)) {
        unfinishedChunks.push({
          received: chunk.confirmedReceived,
          offset: chunk.confirmedOffset,
          size: chunk.confirmedSize,
          url: chunk.url,
        });
        if (this.mBusyWorkers[chunk.workerId] !== undefined) {
          this.mBusyWorkers[chunk.workerId].pause();
          this.stopWorker(chunk.workerId);
        }
      }
    });
    // remove from queue
    this.mQueue = this.mQueue.filter(
      (value: IRunningDownload) => value.id !== id);

    return unfinishedChunks;
  }

  private resolveUrl(input: string): Promise<string[]> {
    if ((this.mResolveCache[input] !== undefined)
      && ((Date.now() - this.mResolveCache[input].time) < URL_RESOLVE_EXPIRE_MS)) {
      return Promise.resolve(this.mResolveCache[input].urls);
    }
    const protocol = url.parse(input).protocol;
    if (!truthy(protocol)) {
      return Promise.resolve([]);
    }
    const handler = this.mProtocolHandlers[protocol.slice(0, protocol.length - 1)];

    return (handler !== undefined)
      ? handler(input)
        .catch(err => {
          log('warn', 'failed to resolve', err.message);
          return Promise.resolve({ urls: [] });
        })
        .then(res => {
          this.mResolveCache[input] = { time: Date.now(), urls: res.urls };
          return res.urls;
        })
      : Promise.resolve([input]);
  }

  private resolveUrls(urls: string[]): () => Promise<string[]> {
    let cache: Promise<string[]>;

    return () => {
      if (cache === undefined) {
        // TODO: Does it make sense here to resolve all urls?
        //   For all we know they could resolve to an empty list so
        //   it wouldn't be enough to just one source url
        cache = Promise.map(urls, iter => this.resolveUrl(iter))
        .then(res => {
          return [].concat(...res);
        });
      }
      return cache;
    };
  }

  private initChunk(download: IRunningDownload): IDownloadJob {
    let fileNameFromURL: string;
    return {
      url: () => download.resolvedUrls()
        .then(urls => {
          if ((fileNameFromURL === undefined) && (urls.length > 0)) {
            const urlIn = urls[0].split('<')[0];
            fileNameFromURL = decodeURI(path.basename(url.parse(urlIn).pathname));
          }
          return urls[0];
        }),
      confirmedOffset: 0,
      confirmedSize: this.mMinChunkSize,
      confirmedReceived: 0,
      offset: 0,
      state: 'init',
      received: 0,
      size: this.mMinChunkSize,
      errorCB: (err) => { this.cancelDownload(download, err); },
      responseCB: (size: number, fileName: string, chunkable: boolean) =>
        this.updateDownload(download, size, fileName || fileNameFromURL, chunkable),
    };
  }

  private cancelDownload(download: IRunningDownload, err: Error) {
    for (const chunk of download.chunks) {
      if (chunk.state === 'running') {
        if (this.mBusyWorkers[chunk.workerId] !== undefined) {
          this.mBusyWorkers[chunk.workerId].cancel();
        }
        chunk.state = 'paused';
      }
    }
    download.failedCB(err);
  }

  private tickQueue() {
    let freeSpots: number = this.mMaxWorkers - Object.keys(this.mBusyWorkers).length;
    let idx = 0;
    while ((freeSpots > 0) && (idx < this.mQueue.length)) {
      let unstartedChunks = countIf(this.mQueue[idx].chunks, value => value.state === 'init');
      while ((freeSpots > 0) && (unstartedChunks > 0)) {
        --unstartedChunks;
        this.startWorker(this.mQueue[idx])
          .then(() => {
            --freeSpots;
          })
          .catch(err => {
            if (this.mQueue[idx] !== undefined) {
              this.mQueue[idx].failedCB(err);
            }
            this.mQueue.splice(idx, 1);

          });
        --freeSpots;
      }
      ++idx;
    }
  }

  private startWorker(download: IRunningDownload) {
    const workerId: number = this.mNextId++;
    this.mSpeedCalculator.initCounter(workerId);

    const job: IDownloadJob = download.chunks.find(ele => ele.state === 'init');
    job.state = 'running';
    job.workerId = workerId;

    return this.startJob(download, job);
  }

  private makeProgressCB(job: IDownloadJob, download: IRunningDownload) {
    return (bytes) => {
      const starving = this.mSpeedCalculator.addMeasure(job.workerId, bytes);
      if (starving) {
        this.mSlowWorkers[job.workerId] = (this.mSlowWorkers[job.workerId] || 0) + 1;
        // only restart slow workers within 15 minutes after starting the download,
        // otherwise the url may have expired. There is no way to know how long the
        // url remains valid, not even with the nexus api (at least not currently)
        if ((this.mSlowWorkers[job.workerId] > 15)
          && (download.started !== undefined)
          && ((Date.now() - download.started.getTime()) < 15 * 60 * 1000)) {
          log('debug', 'restarting slow worker', { workerId: job.workerId });
          this.mBusyWorkers[job.workerId].restart();
          delete this.mSlowWorkers[job.workerId];
        }
      } else if (starving === false) {
        delete this.mSlowWorkers[job.workerId];
      }
    };
  }

  private startJob(download: IRunningDownload, job: IDownloadJob) {
    if (download.assemblerProm === undefined) {
      download.assemblerProm = FileAssembler.create(download.tempName)
        .tap(assembler => assembler.setTotalSize(download.size));
    }

    job.dataCB = this.makeDataCB(download);

    return download.assemblerProm.then(assembler => {
      download.assembler = assembler;

      log('debug', 'start download worker',
        { name: download.tempName, workerId: job.workerId, size: job.size, offset: job.offset });

      this.mBusyWorkers[job.workerId] = new DownloadWorker(job, this.makeProgressCB(job, download),
        (pause) => this.finishChunk(download, job, pause),
        (headers) => download.headers = headers,
        this.mUserAgent,
        this.mThrottle);
    })
    .catch({ code: 'EBUSY' }, () => Promise.reject(new ProcessCanceled('output file is locked')));
  }

  private makeDataCB(download: IRunningDownload) {
    return (offset: number, data: Buffer) => {
      if (isNaN(download.received)) {
        download.received = 0;
      }
      if (download.assembler.isClosed()) {
        return Promise.reject(new ProcessCanceled('file already closed'));
      }
      // these values will change until the data was written to file
      // so copy them so we write the correct info to state
      const receivedNow = download.received;
      return download.assembler.addChunk(offset, data)
        .then((synced: boolean) => {
          const urls: string[] = Array.isArray(download.urls) ? download.urls : undefined;
          download.received += data.byteLength;
          if (download.received > download.size) {
            download.size = download.received;
          }
          download.progressCB(
              receivedNow, download.size,
              synced
                ? download.chunks.map(this.toStoredChunk)
                : undefined,
              download.chunkable,
              urls,
              download.tempName);
          return Promise.resolve(synced);
        })
        .catch(err => {
          if (!(err instanceof ProcessCanceled)) {
            for (const chunk of download.chunks) {
              if (chunk.state === 'running') {
                this.mBusyWorkers[chunk.workerId].cancel();
              }
            }
            download.failedCB(err);
          }
          return Promise.reject(err);
        });
    };
  }

  private updateDownloadSize(download: IRunningDownload, size: number, chunkable: boolean) {
    if (download.size !== size) {
      download.size = size;
      download.assembler.setTotalSize(size);
    }
    if (chunkable || (download.chunkable === null) || (download.chunkable === undefined)) {
      download.chunkable = chunkable;
    }

}

  private updateDownload(download: IRunningDownload, fileSize: number,
                         fileName: string, chunkable: boolean) {
    if ((fileName !== undefined)
        && (fileName !== download.origName)
        && (download.finalName === undefined)) {
      const newName = this.unusedName(
        path.dirname(download.tempName), fileName, download.redownload);
      newName.then(resolvedName => {
        if (!download.assembler.isClosed()) {
          const oldTempName = download.tempName;
          download.tempName = resolvedName;
          return download.assembler.rename(resolvedName)
            .then(() => {
              download.finalName = newName;
            })
            .catch(err => {
              // if we failed to rename we will try to continue writing to the original file
              // so reset to the original name and remove the temporary one that got reserved
              // for the rename
              download.tempName = oldTempName;
              return fs.removeAsync(resolvedName)
                .catch(() => null)
                .then(() => Promise.reject(err));
            });
        }
      })
      .catch(err => {
        log('error', 'failed to update download name', err.message);
      });
    }

    if (chunkable || (download.chunkable === null) || (download.chunkable === undefined)) {
      download.chunkable = chunkable;
    }

    if (download.size !== fileSize) {
      download.size = fileSize;
      download.assembler.setTotalSize(fileSize);
    }

    if (download.chunks.length > 1) {
      return;
    }

    if ((fileSize > this.mMinChunkSize) && chunkable) {
      // download the file in chunks. We use a fixed number of variable size chunks.
      // Since the download link may expire we need to start all threads asap

      const remainingSize = fileSize - this.mMinChunkSize;

      const maxChunks = Math.min(this.mMaxChunks, this.mMaxWorkers);

      const chunkSize = Math.min(remainingSize,
          Math.max(this.mMinChunkSize, Math.ceil(remainingSize / maxChunks)));

      let offset = this.mMinChunkSize + 1;
      while (offset < fileSize) {
        const minSize = Math.min(chunkSize, fileSize - offset);
        download.chunks.push({
          confirmedReceived: 0,
          confirmedOffset: offset,
          confirmedSize: minSize,
          received: 0,
          offset,
          size: minSize,
          state: 'init',
          url: () => download.resolvedUrls().then(urls => urls[0]),
        });
        offset += chunkSize;
      }
      log('debug', 'downloading file in chunks',
        { size: chunkSize, count: download.chunks.length, max: maxChunks, total: fileSize });
      this.tickQueue();
    } else {
      log('debug', 'download not chunked (no server support or it\'s too small)',
        { name: download.finalName, size: fileSize });
    }
  }

  private toStoredChunk = (job: IDownloadJob): IChunk => {
    return {
      url: job.url,
      size: job.confirmedSize,
      offset: job.confirmedOffset,
      received: job.confirmedReceived,
    };
  }

  private toJob = (download: IRunningDownload, chunk: IChunk, first: boolean): IDownloadJob => {
    let fileNameFromURL: string;
    const job: IDownloadJob = {
      url: () => download.resolvedUrls().then(urls => {
        if ((fileNameFromURL === undefined) && (urls.length > 0)) {
          fileNameFromURL = decodeURI(path.basename(url.parse(urls[0]).pathname));
        }

        return urls[0];
      }),
      confirmedOffset: chunk.offset,
      confirmedSize: chunk.size,
      confirmedReceived: chunk.received,
      offset: chunk.offset,
      state: 'init',
      size: chunk.size,
      received: chunk.received,
      responseCB: first
        ? (size: number, fileName: string, chunkable: boolean) =>
            this.updateDownload(download, size, fileName || fileNameFromURL, chunkable)
        : (size: number, fileName: string, chunkable: boolean) =>
            this.updateDownloadSize(download, size, chunkable),
    };
    if (download.size === undefined) {
      // if the size isn't known yet, use the first job response to update it
      job.responseCB = (size: number, fileName: string, chunkable: boolean) =>
        this.updateDownload(download, size, fileName, chunkable);
    }
    return job;
  }

  /**
   * gets called whenever a chunk runs to the end or is interrupted
   */
  private finishChunk(download: IRunningDownload, job: IDownloadJob, interrupted: boolean) {
    this.stopWorker(job.workerId);

    log('debug', 'stopping chunk worker',
      { interrupted, id: job.workerId, offset: job.offset, size: job.size });

    job.state = (interrupted || (job.size > 0)) ? 'paused' : 'finished';
    if (!interrupted && (job.size > 0)) {
      download.error = true;
    }

    const activeChunk = download.chunks.find(
      (chunk: IDownloadJob) => !['paused', 'finished'].includes(chunk.state));
    if (activeChunk === undefined) {
      let finalPath = download.tempName;
      download.assembler.close()
        .then(() => {
          if (download.finalName !== undefined) {
            return download.finalName
            .then((resolvedPath: string) => {
              finalPath = resolvedPath;
              log('debug', 'renaming download', { from: download.tempName, to: resolvedPath });
              const received = download.chunks.filter(chunk => chunk.state === 'paused')
                ? download.received
                : download.size;
              download.progressCB(received, download.size, undefined,
                                  undefined, undefined, resolvedPath);
              if (download.tempName !== resolvedPath) {
                return fs.renameAsync(download.tempName, resolvedPath);
              } else {
                return Promise.resolve();
              }
            });
          } else if ((download.headers !== undefined)
                     && (download.headers['content-type'] !== undefined)
                     && (contentType.parse(download.headers['content-type']).type === 'text/html')
                     && !download.tempName.toLowerCase().endsWith('.html')) {
            // don't keep html files. It's possible handleHTML already deleted it though
            return fs.removeAsync(download.tempName)
              .catch(err => (err.code !== 'ENOENT')
                  ? Promise.reject(err)
                  : Promise.resolve());
          }
        })
        .catch(err => {
          download.failedCB(err);
        })
        .then(() => {
          const unfinishedChunks = download.chunks
            .filter(chunk => chunk.state === 'paused')
            .map(this.toStoredChunk);
          download.finishCB({
            filePath: finalPath,
            headers: download.headers,
            unfinishedChunks,
            hadErrors: download.error,
            size: Math.max(download.size, download.received),
          });
        });
    }
    this.tickQueue();
  }

  private stopWorker(id: number) {
    this.mSpeedCalculator.stopCounter(id);
    delete this.mBusyWorkers[id];
    delete this.mSlowWorkers[id];
  }

  private sanitizeFilename(input: string): string {
    return input.replace(INVALID_FILENAME_RE, '_');
  }

  /**
   * finds and reserves a not-yet-used file name.
   * If the input filename is sample.txt then this function will try
   * sample.txt, sample.1.txt, sample.2.txt ... until an unused name is found.
   * That file is created empty in an atomic operation no other call to unusedName
   * will return the same file name.
   *
   * @param {string} destination
   * @param {string} fileName
   * @returns {Promise<string>}
   */
  private unusedName(destination: string,
                     fileName: string,
                     redownload: RedownloadMode): Promise<string> {
    fileName = this.sanitizeFilename(fileName);
    if (fileName === '') {
      fileName = 'unnamed';
    }
    return new Promise<string>((resolve, reject) => {
      let fd = null;
      let counter = 0;
      const ext = path.extname(fileName);
      const base = path.basename(fileName, ext);
      let first: boolean = true;
      let fullPath = path.join(destination, fileName);

      const loop = () => {
        fs.openAsync(fullPath, 'wx')
          .then((newFd) => {
            fd = newFd;
            return fs.closeAsync(newFd)
              .catch((err) => {
                // EBADF may be a non-issue. If it isn't we will notice when
                // we try to write to the file
                if (err.code !== 'EBADF') {
                  return Promise.reject(err);
                }
              });
          }).then(() => {
            resolve(fullPath);
          }).catch((err) => {
            ++counter;
            const tryName = `${base}.${counter}${ext}`;
            fullPath = path.join(destination, tryName);
            if (err.code === 'EEXIST') {
              if (first && this.mFileExistsCB !== undefined) {
                first = false;
                if (redownload === 'always') {
                  loop();
                } else if (redownload === 'never') {
                  return reject(new AlreadyDownloaded(fileName));
                } else if (redownload === 'replace') {
                  return resolve(fullPath);
                } else {
                  this.mFileExistsCB(fileName)
                    .then((cont: boolean) => {
                      if (cont) {
                        loop();
                      } else {
                        return reject(new UserCanceled());
                      }
                    })
                    .catch(reject);
                }
              } else {
                loop();
              }
            } else {
              reject(err);
            }
          });
      };
      process.nextTick(loop);
    });
  }

}

export default DownloadManager;
