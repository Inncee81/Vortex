import { startActivity, stopActivity } from '../../../actions/session';
import { IDeployedFile, IDeploymentMethod, IExtensionApi } from '../../../types/IExtensionContext';
import { IGame } from '../../../types/IGame';
import { INotification } from '../../../types/INotification';
import { IProfile } from '../../../types/IState';
import { ProcessCanceled, TemporaryError } from '../../../util/CustomErrors';
import { log } from '../../../util/log';
import { activeProfile, discoveryByGame, lastActiveProfileForGame, profileById } from '../../../util/selectors';
import { getSafe } from '../../../util/storeHelper';
import { truthy } from '../../../util/util';
import { IModType } from '../../gamemode_management/types/IModType';
import { getGame } from '../../gamemode_management/util/getGame';
import { installPath, installPathForGame } from '../selectors';
import { IMod } from '../types/IMod';
import { fallbackPurgeType, getManifest, loadActivation, saveActivation, withActivationLock } from './activationStore';
import { getActivator, getCurrentActivator } from './deploymentMethods';
import { NoDeployment } from './exceptions';
import { dealWithExternalChanges } from './externalChanges';

import Promise from 'bluebird';

const MERGE_SUBDIR = 'zzz_merge';

export function genSubDirFunc(game: IGame, modType: IModType): (mod: IMod) => string {
  const mergeModsOpt = (modType !== undefined) && (modType.options.mergeMods !== undefined)
    ? modType.options.mergeMods
    : game.mergeMods;

  if (typeof(mergeModsOpt) === 'boolean') {
    return mergeModsOpt
      ? () => ''
      : (mod: IMod) => mod !== null ? mod.id : MERGE_SUBDIR;
  } else {
    return (mod: IMod) => {
      try {
        return mergeModsOpt(mod);
      } catch (err) {
        // if the game doesn't implement generating a output path for the merge,
        // use the default
        if (mod === null) {
          return MERGE_SUBDIR;
        } else {
          throw err;
        }
      }
    };
  }
}

function filterManifest(activator: IDeploymentMethod,
                        deployPath: string,
                        stagingPath: string,
                        deployment: IDeployedFile[]): Promise<IDeployedFile[]> {
  return Promise.filter(deployment, file =>
    activator.isDeployed(stagingPath, deployPath, file));
}

export function loadAllManifests(api: IExtensionApi,
                                 deploymentMethod: IDeploymentMethod,
                                 gameId: string,
                                 modPaths: { [typeId: string]: string },
                                 stagingPath: string) {
  const modTypes = Object.keys(modPaths).filter(typeId => truthy(modPaths[typeId]));

  return Promise.reduce(modTypes, (prev, typeId) =>
        loadActivation(api, gameId, typeId, modPaths[typeId], stagingPath, deploymentMethod)
          .then(deployment => {
            prev[typeId] = deployment;
            return prev;
          }), {});
}

export function purgeMods(api: IExtensionApi,
                          gameId?: string,
                          isUnmanaging?: boolean): Promise<void> {
  const state = api.store.getState();
  let profile = gameId !== undefined
    ? profileById(state, lastActiveProfileForGame(state, gameId))
    : activeProfile(state);

  if (isUnmanaging && profile === undefined) {
    // This block intends to cater for a use case where the user is attempting
    //  to unmanage his game but has removed the last active profile manually
    //  through the profiles page. The user most definitely still has profiles
    //  for the game as the game entry gets removed if all have been deleted.
    // Given that the user is attempting to unmanage his game, we do not want
    //  to block him from purging the mods. Any profile will do.
    const profiles: { [profileId: string]: IProfile } =
      getSafe(state, ['persistent', 'profiles'], {});

    const profileId = Object.keys(profiles)
      .filter(id => profiles[id].gameId === gameId)
      .pop();

    profile = profiles?.[profileId];
  }

  if (profile === undefined) {
    return Promise.reject(new TemporaryError('No active profile'));
  }

  return getManifest(api, '', gameId)
    .then(manifest => {
      if (manifest?.deploymentMethod !== undefined) {
        log('info', 'using deployment method from manifest',
            { method: manifest?.deploymentMethod });
        const deployedActivator = getActivator(manifest?.deploymentMethod);
        return purgeModsImpl(api, deployedActivator, profile);
      } else {
        return purgeModsImpl(api, undefined, profile);
      }
    });
}

function purgeModsImpl(api: IExtensionApi, activator: IDeploymentMethod,
                       profile: IProfile): Promise<void> {
  const state = api.store.getState();
  const { gameId } = profile;
  const stagingPath = installPathForGame(state, gameId);
  const gameDiscovery = discoveryByGame(state, gameId);
  const t = api.translate;

  log('info', 'current deployment method is',
    { method: getCurrentActivator(state, gameId, false)?.id });
  if (activator === undefined) {
    activator = getCurrentActivator(state, gameId, false);
  }

  if ((activator === undefined) || (stagingPath === undefined)) {
    // throwing this exception on stagingPath === undefined isn't exactly
    // accurate but the effect is the same: User has to activate the game
    // and review settings before deployment is possible
    return Promise.reject(new NoDeployment());
  }

  if (Object.keys(getSafe(state, ['session', 'base', 'toolsRunning'], {})).length > 0) {
    api.sendNotification({
      type: 'info',
      id: 'purge-not-possible',
      message: 'Can\'t purge while the game or a tool is running',
      displayMS: 5000,
    });
    return Promise.resolve();
  }

  const notification: INotification = {
    type: 'activity',
    message: t('Waiting for other operations to complete'),
    title: t('Purging'),
  };

  notification.id = api.sendNotification(notification);

  const game: IGame = getGame(gameId);
  const modPaths = game.getModPaths(gameDiscovery.path);

  const modTypes = Object.keys(modPaths).filter(typeId => truthy(modPaths[typeId]));

  return withActivationLock(() => {
    log('debug', 'purging mods', { activatorId: activator.id, stagingPath });
    notification.message = t('Purging mods');
    api.sendNotification(notification);

    let lastDeployment: { [typeId: string]: IDeployedFile[] };
    api.store.dispatch(startActivity('mods', 'purging'));

    // TODO: we really should be using the deployment specified in the manifest,
    //   not the current one! This only works because we force a purge when switching
    //   deployment method.
    return activator.prePurge(stagingPath)
      // load previous deployments
      .then(() => loadAllManifests(api, activator, gameId, modPaths, stagingPath)
        .then(deployments => { lastDeployment = deployments; }))
      .then(() => api.emitAndAwait('will-purge', profile.id, lastDeployment))
      // deal with all external changes
      .then(() => dealWithExternalChanges(api, activator, profile.id, stagingPath,
                                          modPaths, lastDeployment))
      // purge all mod types
      .then(() => Promise.mapSeries(modTypes, typeId =>
          activator.purge(stagingPath, modPaths[typeId], gameId)))
      // save (empty) activation
      .then(() => Promise.map(modTypes, typeId =>
          saveActivation(gameId, typeId, state.app.instanceId, modPaths[typeId], stagingPath,
                         [], activator.id)))
      // the deployment may be changed so on an exception we still need to update it
      .tapCatch(() => {
        if (lastDeployment === undefined) {
          // exception happened before the deployment is even loaded so there is nothing
          // to clean up
          return;
        }
        return Promise.map(modTypes, typeId =>
          filterManifest(activator, modPaths[typeId], stagingPath, lastDeployment[typeId])
            .then(files =>
              saveActivation(gameId, typeId, state.app.instanceId, modPaths[typeId], stagingPath,
                files, activator.id)));
      })
      .catch(ProcessCanceled, () => null)
      .then(() => Promise.resolve())
      .finally(() => activator.postPurge())
      .then(() => api.emitAndAwait('did-purge', profile.id));
  }, true)
    .then(() => null)
    .finally(() => {
      api.dismissNotification(notification.id);
      api.store.dispatch(stopActivity('mods', 'purging'));
    });
}

export function purgeModsInPath(api: IExtensionApi, gameId: string, typeId: string,
                                modPath: string): Promise<void> {
  const state = api.store.getState();
  const profile: IProfile = (gameId !== undefined)
    ? profileById(state, lastActiveProfileForGame(state, gameId))
    : activeProfile(state);

  if (gameId === undefined) {
    gameId = profile.gameId;
  }
  const stagingPath = installPathForGame(state, gameId);

  const t = api.translate;
  const activator = getCurrentActivator(state, gameId, false);

  if (activator === undefined) {
    return Promise.reject(new NoDeployment());
  }

  if (Object.keys(getSafe(state, ['session', 'base', 'toolsRunning'], {})).length > 0) {
    api.sendNotification({
      type: 'info',
      id: 'purge-not-possible',
      message: 'Can\'t purge while the game or a tool is running',
      displayMS: 5000,
    });
    return Promise.resolve();
  }

  const notification: INotification = {
    type: 'activity',
    message: t('Waiting for other operations to complete'),
    title: t('Purging'),
  };

  notification.id = api.sendNotification(notification);

  return withActivationLock(() => {
    log('debug', 'purging mods', { activatorId: activator.id, stagingPath });
    notification.message = t('Purging mods');
    api.sendNotification(notification);

    if ((gameId !== undefined) && (profile === undefined)) {
      // gameId was set but we have no last active profile for that game.
      // In this case there is probably nothing to purge but if that's true
      // there will also be no manifest so we can just as easily try a fallback
      // purge just to be safe.
      return fallbackPurgeType(api, activator, gameId, typeId, modPath, stagingPath);
    }

    // TODO: we really should be using the deployment specified in the manifest,
    //   not the current one! This only works because we force a purge when switching
    //   deployment method.
    return activator.prePurge(stagingPath)
      // purge the specified mod type
      .then(() => activator.purge(stagingPath, modPath, gameId))
      // save (empty) activation
      .then(() => saveActivation(gameId, typeId, state.app.instanceId, modPath, stagingPath,
                         [], activator.id))
      .catch(ProcessCanceled, () => null)
      .then(() => Promise.resolve())
      .finally(() => activator.postPurge())
      .then(() => api.emitAndAwait('did-purge', profile.id));
  }, true)
    .then(() => null)
    .finally(() => {
      api.dismissNotification(notification.id);
    });
}
