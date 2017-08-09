import { selectImportFolder, setImportStep } from './actions/session';
import { sessionReducer } from './reducers/session';
import ImportDialog from './views/ImportDialog';

import * as Promise from 'bluebird';
import * as fs from 'fs-extra-promise';
import { selectors, types, util } from 'nmm-api';
import * as path from 'path';

function init(context: types.IExtensionContext): boolean {
  if (process.platform !== 'win32') {
    // not going to work on other platforms because some of the path resolution
    // assumes windows.
    return false;
  }

  context.registerDialog('nmm-import', ImportDialog);

  context.registerReducer(['session', 'modmigration'], sessionReducer);
  context.registerAction('mod-icons', 115, 'import', {}, 'Import from NMM', () => {
    context.api.store.dispatch(setImportStep('start'));
  });

  context.once(() => {
    context.api.setStylesheet('nexus-migration-tool', path.join(__dirname, 'migration-tool.scss'));
  });

  return true;
}

export default init;
