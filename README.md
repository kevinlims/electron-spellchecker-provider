# electron-spellchecker-provider

electron-spellchecker-provider is a library to help you implement spellchecking in your Electron applications. This library intends to solve the problem of spellchecking in a production-ready, international-friendly way.

electron-spellchecker-provider:

* Spell checks in all of the languages that Google Chrome supports by reusing its dictionaries.
* Handles locale correctly and automatically (i.e. users who are from Australia should not be corrected for 'colour', but US English speakers should)
* Checks very quickly, doesn't introduce input lag which is extremely noticable
* Only loads one Dictionary at a time which saves a significant amount of memory
