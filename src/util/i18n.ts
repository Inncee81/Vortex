import * as fs from './fs';
import { log } from './log';

import * as Promise from 'bluebird';
import { app as appIn, remote } from 'electron';
import I18next from 'i18next';
import * as FSBackend from 'i18next-node-fs-backend';

import * as path from 'path';
import getVortexPath from './getVortexPath';

const app = remote !== undefined ? remote.app : appIn;

let debugging = false;
let currentLanguage = 'en';
let fallbackTFunc: I18next.TFunction =
  str => (Array.isArray(str) ? str[0].toString() : str.toString()) as any;

export { fallbackTFunc };

interface ITranslationEntry {
  lng: string;
  ns: string;
  key: string;
}
let missingKeys = { common: {} };

export interface IInitResult {
  i18n: I18next.i18n;
  tFunc: I18next.TFunction;
  error?: Error;
}

class MultiBackend {
  private static type = 'backend';
  private mOptions: any;
  private mBundled: FSBackend;
  private mUser: FSBackend;
  private mLangUser: { [language: string]: boolean } = {};

  constructor(services, options) {
    this.mBundled = new FSBackend(services);
    this.mUser = new FSBackend(services);
    this.init(services, options);
  }

  public init(services, options) {
    this.mOptions = options;
    if (options !== undefined) {
      this.mBundled.init(services, {
        loadPath: path.join(options.bundled, '{{lng}}', '{{ns}}.json'),
        jsonIndent: 2,
      });
      this.mUser.init(services, {
        loadPath: path.join(options.user, '{{lng}}', '{{ns}}.json'),
        jsonIndent: 2,
      });
    }
  }

  public read(language: string, namespace: string, callback) {
    const backend = this.langUser(language) ? this.mUser : this.mBundled;
    backend.read(language, namespace, callback);
  }

  private langUser(language: string) {
    if (this.mLangUser[language] === undefined) {
      try {
        fs.statSync(path.join(this.mOptions.user, language));
        this.mLangUser[language] = true;
      } catch (err) {
        this.mLangUser[language] = false;
      }
    }
    return this.mLangUser[language];
  }
}

/**
 * initialize the internationalization library
 *
 * @export
 * @param {string} language
 * @returns {I18next.I18n}
 */
function init(language: string): Promise<IInitResult> {
  currentLanguage = language;

  const i18n = I18next.use(MultiBackend);

  return Promise.resolve(i18n.init(
    {
      lng: language,
      fallbackLng: 'en',
      fallbackNS: 'common',

      ns: ['common'],
      defaultNS: 'common',

      nsSeparator: ':::',
      keySeparator: '::',

      debug: false,

      saveMissing: debugging,

      missingKeyHandler: (lng, ns, key, fallbackValue) => {
        if (missingKeys[ns] === undefined) {
          missingKeys[ns] = {};
        }
        missingKeys[ns][key] = key;
      },

      interpolation: {
        escapeValue: false,
      },

      backend: {
        bundled: getVortexPath('locales'),
        user: path.normalize(path.join(app.getPath('userData'), 'locales')),
      },
    }))
    .then(tFunc => Promise.resolve({
      i18n,
      tFunc,
    }))
    .catch((error) => ({
      i18n,
      tFunc: fallbackTFunc,
      error,
    }));
}

export function getCurrentLanguage() {
  return currentLanguage;
}

export function globalT(key: string | string[], options: I18next.TOptions) {
  return fallbackTFunc(key, options);
}

export function debugTranslations(enable?: boolean) {
  debugging = (enable !== undefined)
    ? enable
    : !debugging;
  missingKeys = { common: {} };
  init(I18next.language);
}

export function getMissingTranslations() {
  return missingKeys;
}

export default init;
