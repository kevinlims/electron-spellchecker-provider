import {of} from 'rxjs'
import path from 'path';
import mkdirp from 'mkdirp';

import {fs} from './promisify';
import {normalizeLanguageCode} from './utility';

let getURLForHunspellDictionary;
let setBaseUrlForHunspellDictionary;
let d = require('debug')('electron-spellchecker-provider:dictionary-sync');

const app = process.type === 'renderer' ?
  require('electron').remote.app :
  require('electron').app;

let downloader;

function downloadFileOrUrl (url, target) {
  if (downloader) {
    return downloader(url, target);
  }

  const ajax = require.resolve('@juturu/electron-remote/remote-ajax');
  const {downloadFileOrUrl} = require('@juturu/electron-remote').requireTaskPool(ajax);

  return downloadFileOrUrl(url, target);
}

/**
 * DictioanrySync handles downloading and saving Hunspell dictionaries. Pass it
 * to {{SpellCheckHandler}} to configure a custom cache directory.
 */
export default class DictionarySync {
  /**
   * Creates a DictionarySync
   *
   * @param  {String} cacheDir    The path to a directory to store dictionaries.
   *                              If not given, the Electron user data directory
   *                              will be used.
   */
  constructor(cacheDir=null) {
    // NB: Require here so that consumers can handle native module exceptions.
    var nodeSpellchecker = require('./node-spellchecker');
    getURLForHunspellDictionary = nodeSpellchecker.getURLForHunspellDictionary;
    setBaseUrlForHunspellDictionary = nodeSpellchecker.setBaseUrlForHunspellDictionary;

    this.cacheDir = cacheDir || path.join(app.getPath('userData'), 'dictionaries');
    mkdirp.sync(this.cacheDir);
  }

  /**
   * Override the default logger for this class. You probably want to use
   * {{setGlobalLogger}} instead
   *
   * @param {Function} fn   The function which will operate like console.log
   */
  static setLogger(fn) {
    d = fn;
  }

  /**
   * Overrides the default electron-remote/remote-ajax downloader
   * @param {Function} fn
   */
  static setDownloader(fn) {
    downloader = fn
  }

  /**
   * Overrides the default base URL for loading dictionary
   */
  setBaseUrlForDictionary(url) {
    if (setBaseUrlForHunspellDictionary && url) {
      setBaseUrlForHunspellDictionary(url);
    }
  }

  /**
   * Loads the dictionary for a given language code, trying first to load a
   * local version, then downloading it. You probably don't want this method
   * directly, but the wrapped version
   * {{loadDictionaryForLanguageWithAlternatives}} which is in {{SpellCheckHandler}}.
   *
   * @param  {String} langCode        The language code (i.e. 'en-US')
   * @param  {Boolean} cacheOnly      If true, don't load the file content into
   *                                  memory, only download it
   *
   * @return {Promise<Buffer|String>}     A Buffer of the file contents if
   *                                      {{cacheOnly}} is False, or the path to
   *                                      the file if True.
   */
  async loadDictionaryForLanguage(langCode, cacheOnly=false) {
    d(`Loading dictionary for language ${langCode}`);
    if (process.platform === 'darwin') return new Buffer([]);

    let lang = normalizeLanguageCode(langCode);
    let target = path.join(this.cacheDir, `${lang}.bdic`);

    let fileExists = false;
    try {
      if (fs.existsSync(target)) {
        fileExists = true;

        d(`Returning local copy: ${target}`);
        let ret = await fs.readFile(target, {});

        if (ret.length < 8*1024) {
          throw new Error("File exists but is most likely bogus");
        }

        return ret;
      }
    } catch (e) {
      d(`Failed to read file ${target}: ${e.message}`);
    }

    if (fileExists) {
      try {
        await fs.unlink(target);
      } catch (e) {
        d("Can't clear out file, bailing");
        throw e;
      }
    }

    let url = getURLForHunspellDictionary(lang);
    d(`Actually downloading ${url}`);
    await downloadFileOrUrl(url, target);

    if (cacheOnly) return target;

    let ret = await fs.readFile(target, {});
    if (ret.length < 8*1024) {
      throw new Error("File exists but is most likely bogus");
    }

    return ret;
  }

  preloadDictionaries() {
    // NB: This is retained solely to not break earlier versions
    return of(true);
  }
}
