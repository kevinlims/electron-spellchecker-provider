import {getInstalledKeyboardLanguages} from 'keyboard-layout';
import {spawn} from 'spawn-rx';
import LRU from 'lru-cache';

import {Observable} from 'rxjs/Observable';

import 'rxjs/add/observable/defer';
import 'rxjs/add/observable/fromPromise';
import 'rxjs/add/observable/of';

import 'rxjs/add/operator/catch';
import 'rxjs/add/operator/concat';
import 'rxjs/add/operator/concatMap';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/reduce';
import 'rxjs/add/operator/take';
import 'rxjs/add/operator/toPromise';

import './custom-operators';

import DictionarySync from './dictionary-sync';
import {normalizeLanguageCode} from './utility';
import FakeLocalStorage from './fake-local-storage';

let Spellchecker;

let d = require('debug')('electron-spellchecker-provider:spell-check-handler');

let fallbackLocaleTable = null;

// NB: Linux and Windows uses underscore in languages (i.e. 'en_US'), whereas
// we're trying really hard to match the Chromium way of `en-US`
const validLangCodeWindowsLinux = /[a-z]{2}[_][A-Z]{2}/;

const isMac = process.platform === 'darwin';

// NB: This is to work around electron/electron#1005, where contractions
// are incorrectly marked as spelling errors. This lets people get away with
// incorrectly spelled contracted words, but it's the best we can do for now.
const contractions = [
  "ain't", "aren't", "can't", "could've", "couldn't", "couldn't've", "didn't", "doesn't", "don't", "hadn't",
  "hadn't've", "hasn't", "haven't", "he'd", "he'd've", "he'll", "he's", "how'd", "how'll", "how's", "I'd",
  "I'd've", "I'll", "I'm", "I've", "isn't", "it'd", "it'd've", "it'll", "it's", "let's", "ma'am", "mightn't",
  "mightn't've", "might've", "mustn't", "must've", "needn't", "not've", "o'clock", "shan't", "she'd", "she'd've",
  "she'll", "she's", "should've", "shouldn't", "shouldn't've", "that'll", "that's", "there'd", "there'd've",
  "there're", "there's", "they'd", "they'd've", "they'll", "they're", "they've", "wasn't", "we'd", "we'd've",
  "we'll", "we're", "we've", "weren't", "what'll", "what're", "what's", "what've", "when's", "where'd",
  "where's", "where've", "who'd", "who'll", "who're", "who's", "who've", "why'll", "why're", "why's", "won't",
  "would've", "wouldn't", "wouldn't've", "y'all", "y'all'd've", "you'd", "you'd've", "you'll", "you're", "you've"
];

const contractionMap = contractions.reduce((acc, word) => {
  acc[word.replace(/'.*/, '')] = true;
  return acc;
}, {});


/**
 * SpellCheckHandler is the main class of this library, and handles all of the
 * different pieces of spell checking.
 *
 * Sample text should be text that is reasonably likely to be in the same language
 * as the user typing - for example, in an Email reply box, the original Email text
 * would be a great sample, or in the case of Slack, the existing channel messages
 * are used as the sample text.
 */
export default class SpellCheckHandler {
  /**
   * Constructs a SpellCheckHandler
   *
   * @param  {DictionarySync} dictionarySync  An instance of {{DictionarySync}},
   *                                          create a custom one if you want
   *                                          to override the dictionary cache
   *                                          location.
   * @param  {LocalStorage} localStorage      An implementation of localStorage
   *                                          used for testing.
   * @param  {boolean} forceDefaultSpellCheck A flag for enforcing the default 
   *                                          behavior of the spellchecker to  
   *                                          all OS
   */
  constructor(dictionarySync=null, localStorage=null, forceDefaultSpellCheck = false) {
    // NB: Require here so that consumers can handle native module exceptions.
    Spellchecker = require('./node-spellchecker').Spellchecker;

    this.dictionarySync = dictionarySync || new DictionarySync();
    this.currentSpellchecker = null;
    this.currentSpellcheckerLanguage = null;
    this.isMisspelledCache = new LRU({
      max: 512,
      maxAge: 8 * 1000
    });

    this.shouldAutoCorrect = true;
    
    this.forceDefaultSpellCheck = forceDefaultSpellCheck

    // NB: A Cool thing is when window.localStorage is rigged to blow up
    // if you touch it from a data: URI in Chromium.
    try {
      this.localStorage = localStorage || window.localStorage || new FakeLocalStorage();
    } catch (ugh) {
      this.localStorage = new FakeLocalStorage();
    }

    if (isMac && !this.forceDefaultSpellCheck) {
      // NB: OS X does automatic language detection, we're gonna trust it
      this.currentSpellchecker = new Spellchecker();
      this.currentSpellcheckerLanguage = 'en-US';

      return;
    }
  }

  /**
   * Disconnect the events that we connected in the class.
   */
  unsubscribe() {
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
   * Explicitly switch the language to a specific language. This method will
   * automatically download the dictionary for the specific language and locale
   * and on failure, will attempt to switch to dictionaries that are the same
   * language but a default locale.
   *
   * @param  {String} langCode    A language code (i.e. 'en-US')
   *
   * @return {Promise}            Completion
   */
  async switchLanguage(langCode) {
    let actualLang;
    let dict = null;
    if (isMac && !this.forceDefaultSpellCheck) return;

    try {
      const {dictionary, language} = await this.loadDictionaryForLanguageWithAlternatives(langCode);
      actualLang = language; dict = dictionary;
    } catch (e) {
      d(`Failed to load dictionary ${langCode}: ${e.message}`);
      throw e;
    }

    if (!dict) {
      d(`dictionary for ${langCode}_${actualLang} is not available`);
      this.currentSpellcheckerLanguage = actualLang;
      this.currentSpellchecker = null;
      return;
    }

    d(`Setting current spellchecker to ${actualLang}, requested language was ${langCode}`);
    if (this.currentSpellcheckerLanguage !== actualLang || !this.currentSpellchecker) {
      d(`Creating node-spellchecker instance`);

      this.currentSpellchecker = new Spellchecker();
      this.currentSpellchecker.setDictionary(actualLang, dict);
      this.currentSpellcheckerLanguage = actualLang;
    }
  }

  /**
   * Loads a dictionary and attempts to use fallbacks if it fails.
   * @private
   */
  async loadDictionaryForLanguageWithAlternatives(langCode, cacheOnly=false) {
    const localStorageKey =  'electronSpellchecker_alternatesTable';

    this.fallbackLocaleTable = this.fallbackLocaleTable || require('./fallback-locales');
    let lang = langCode.substring(0, 2);

    let alternatives = [langCode, await this.getLikelyLocaleForLanguage(lang), this.fallbackLocaleTable[lang]];
    let alternatesTable = JSON.parse(this.localStorage.getItem(localStorageKey) || '{}');

    if (langCode in alternatesTable) {
      try {
        return {
          language: alternatesTable[langCode],
          dictionary: await this.dictionarySync.loadDictionaryForLanguage(alternatesTable[langCode])
        };
      } catch (e) {
        // If we fail to load a saved alternate, this is an indicator that our
        // data is garbage and we should throw it out entirely.
        this.localStorage.setItem(localStorageKey, '{}');
      }
    }

    d(`Requesting to load ${langCode}, alternatives are ${JSON.stringify(alternatives)}`);
    return await Observable.of(...alternatives)
      .concatMap((l) => {
        return Observable.defer(() =>
            Observable.fromPromise(this.dictionarySync.loadDictionaryForLanguage(l, cacheOnly)))
          .map((d) => ({language: l, dictionary: d}))
          .do(({language}) => {
            alternatesTable[langCode] = language;
            this.localStorage.setItem(localStorageKey, JSON.stringify(alternatesTable));
          })
          .catch(() => Observable.of(null));
      })
      .concat(Observable.of({language: langCode, dictionary: null}))
      .filter((x) => x !== null)
      .take(1)
      .toPromise();
  }

  /**
   * Calculates whether a word is missspelled, using an LRU cache to memoize
   * the callout to the actual spell check code.
   *
   * @private
   */
  isMisspelled(text) {
    let result = this.isMisspelledCache.get(text);
    if (result !== undefined) {
      return result;
    }

    result = (() => {
      if (contractionMap[text.toLocaleLowerCase()]) {
        return false;
      }

      if (!this.currentSpellchecker) return false;

      if (isMac && !this.forceDefaultSpellCheck) {
        return this.currentSpellchecker.isMisspelled(text);
      }

      // NB: I'm not smart enough to fix this bug in Chromium's version of
      // Hunspell so I'm going to fix it here instead. Chromium Hunspell for
      // whatever reason marks the first word in a sentence as mispelled if it is
      // capitalized.
      result = this.currentSpellchecker.checkSpelling(text);
      if (result.length < 1) {
        return false;
      }

      if (result[0].start !== 0) {
        // If we're not at the beginning, we know it's not a false positive
        return true;
      }

      // Retry with lowercase
      return this.currentSpellchecker.isMisspelled(text.toLocaleLowerCase());
    })();

    this.isMisspelledCache.set(text, result);
    return result;
  }

  /**
   * Returns the locale for a language code based on the user's machine (i.e.
   * 'en' => 'en-GB')
   */
  async getLikelyLocaleForLanguage(language) {
    let lang = language.toLowerCase();
    if (!this.likelyLocaleTable) this.likelyLocaleTable = await this.buildLikelyLocaleTable();

    if (this.likelyLocaleTable[lang]) return this.likelyLocaleTable[lang];
    this.fallbackLocaleTable = this.fallbackLocaleTable || require('./fallback-locales');

    return this.fallbackLocaleTable[lang];
  }

  /**
   * A proxy for the current spellchecker's method of the same name
   * @private
   */
  async getCorrectionsForMisspelling(text) {
    if (!this.currentSpellchecker) {
      return null;
    }

    return this.currentSpellchecker.getCorrectionsForMisspelling(text);
  }

  /**
   * A proxy for the current spellchecker's method of the same name
   * @private
   */
  async addToDictionary(text) {
    // NB: Same deal as getCorrectionsForMisspelling.
    if (!isMac || this.forceDefaultSpellCheck) return;
    if (!this.currentSpellchecker) return;

    this.currentSpellchecker.add(text);
  }

  /**
   * Call out to the OS to figure out what locales the user is probably
   * interested in then save it off as a table.
   * @private
   */
  async buildLikelyLocaleTable() {
    let localeList = [];

    if (process.platform === 'linux') {
      let locales = await spawn('locale', ['-a'])
        .catch(() => Observable.of(null))
        .reduce((acc,x) => { acc.push(...x.split('\n')); return acc; }, [])
        .toPromise();

      d(`Raw Locale list: ${JSON.stringify(locales)}`);

      localeList = locales.reduce((acc, x) => {
        let m = x.match(validLangCodeWindowsLinux);
        if (!m) return acc;

        acc.push(m[0]);
        return acc;
      }, []);
    }

    if (process.platform === 'win32') {
      localeList = getInstalledKeyboardLanguages();
    }

    if (isMac && !this.forceDefaultSpellCheck) {
      fallbackLocaleTable = fallbackLocaleTable || require('./fallback-locales');

      // NB: OS X will return lists that are half just a language, half
      // language + locale, like ['en', 'pt_BR', 'ko']
      localeList = this.currentSpellchecker.getAvailableDictionaries()
        .map((x => {
          if (x.length === 2) return fallbackLocaleTable[x];
          return normalizeLanguageCode(x);
        }));
    }

    d(`Filtered Locale list: ${JSON.stringify(localeList)}`);

    // Some distros like Ubuntu make locale -a useless by dumping
    // every possible locale for the language into the list :-/
    let counts = localeList.reduce((acc,x) => {
      let k = x.substring(0,2);
      acc[k] = acc[k] || [];
      acc[k].push(x);

      return acc;
    }, {});

    d(`Counts: ${JSON.stringify(counts)}`);

    let ret = Object.keys(counts).reduce((acc, x) => {
      if (counts[x].length > 1) return acc;

      d(`Setting ${x}`);
      acc[x] = normalizeLanguageCode(counts[x][0]);

      return acc;
    }, {});

    // NB: LANG has a Special Place In Our Hearts
    if (process.platform === 'linux' && process.env.LANG) {
      let m = process.env.LANG.match(validLangCodeWindowsLinux);
      if (!m) return ret;

      ret[m[0].substring(0, 2)] = normalizeLanguageCode(m[0]);
    }

    d(`Result: ${JSON.stringify(ret)}`);
    return ret;
  }
}
