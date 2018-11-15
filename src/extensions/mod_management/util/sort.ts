import { showDialog } from '../../../actions';
import { IExtensionApi } from '../../../types/IExtensionContext';
import { log } from '../../../util/log';
import { getSafe } from '../../../util/storeHelper';

import { IMod } from '../types/IMod';

import testModReference from './testModReference';

import * as Promise from 'bluebird';
import * as _ from 'lodash';
import { alg, Graph } from 'graphlib';
import { ILookupResult, IReference, IRule, RuleType } from 'modmeta-db';

function findByRef(mods: IMod[], reference: IReference): IMod {
  return mods.find((mod: IMod) => testModReference(mod, reference));
}

function showCycles(api: IExtensionApi, cycles: string[][]) {
  api.store.dispatch(showDialog('error', 'Cycles', {
    text: 'Dependency rules between your mods contain cycles, '
      + 'like "A after B" and "B after A". You need to remove one of the '
      + 'rules causing the cycle, otherwise your mods can\'t be '
      + 'applied in the right order.',
    links: cycles.map((cycle, idx) => (
      { label: cycle.join(', '), action: () => {
        api.events.emit('edit-mod-cycle', cycle);
      } }
    )),
  }, [
    { label: 'Close' },
  ]));
}

let sortModsCache: { id: { gameId: string, mods: IMod[] }, sorted: Promise<IMod[]> } =
  { id: { gameId: undefined, mods: [] }, sorted: Promise.resolve([]) };

function sortMods(gameId: string, mods: IMod[], api: IExtensionApi): Promise<IMod[]> {
  if (mods.length === 0) {
    // don't flush the cache if the input is empty
    return Promise.resolve([]);
  }

  if ((sortModsCache.id.gameId === gameId)
    && _.isEqual(sortModsCache.id.mods, mods)) {
    return sortModsCache.sorted;
  }

  const dependencies = new Graph();

  const modMapper = (mod: IMod) => {
    return api.lookupModMeta({
                fileMD5: getSafe(mod.attributes, ['fileMD5'], undefined),
                fileSize: getSafe(mod.attributes, ['size'], undefined),
                gameId,
              })
        .catch(() => [])
        .then((metaInfo: ILookupResult[]) => {
          const rules = [].concat(
            getSafe(metaInfo, [0, 'value', 'rules'], []),
            mod.rules || []);
          rules.forEach((rule: IRule) => {
            const ref = findByRef(mods, rule.reference);
            if (ref !== undefined) {
              if (rule.type === 'before') {
                dependencies.setEdge(mod.id, ref.id);
              } else if (rule.type === 'after') {
                dependencies.setEdge(ref.id, mod.id);
              }
            }
          });
          return Promise.resolve();
        });
  };

  mods.forEach(mod => { dependencies.setNode(mod.id); });

  let sorted = Promise.map(mods, modMapper)
    .catch((err: Error) => {
      log('error', 'failed to sort mods',
          {msg: err.message, stack: err.stack});
    })
    .then(() => {
      try {
        const res = alg.topsort(dependencies);
        api.dismissNotification('mod-cycle-warning');
        const lookup = mods.reduce((prev, mod) => {
          prev[mod.id] = mod;
          return prev;
        }, {});
        return Promise.resolve(res.map(id => lookup[id]));
      } catch (err) {
        // exception type not included in typings
        if (err instanceof (alg.topsort as any).CycleException) {
          api.sendNotification({
            id: 'mod-cycle-warning',
            type: 'warning',
            message: 'Mod rules contain cycles',
            actions: [
              { title: 'Show', action: () => {
                showCycles(api, alg.findCycles(dependencies));
              } },
            ],
          });
          // return unsorted
          return Promise.resolve(mods);
        } else {
          return Promise.reject(err);
        }
      }
    });

  sortModsCache = { id: { gameId, mods }, sorted };

  return sorted;
}

function renderCycles(cycles: string[][]): string {
  return cycles.map((cycle, idx) =>
    `<li>Cycle ${idx + 1}: ${cycle.join(', ')}</li>`).join('<br />');
}

export default sortMods;
