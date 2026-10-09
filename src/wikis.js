/**
 * Wikis the LLM can look things up on. Any MediaWiki site works (Fextralife, Fandom, wiki.gg...).
 * To add one, add an entry here and list its id in WIKIS. It becomes a tool named lookup_<id>_wiki.
 *
 * - game:     the game's name, used in the tool description and the system prompt
 * - site:     who runs the wiki, shown in the tool description
 * - baseUrl:  the wiki root; its MediaWiki API must be at <baseUrl>/api.php
 * - covers:   what the wiki has pages on, for the tool description
 * - askAbout: kinds of questions that must be looked up, for the system prompt
 * - examples: good page-name queries, shown to the LLM
 * TODO: The examples thing kind of sucks, lets just remove that and get grok to rewrite the query?
 * - 9th Oct 2026
 */
export const WIKIS = {
  nightreign: {
    game: 'Elden Ring Nightreign',
    site: 'Fextralife',
    baseUrl: 'https://eldenringnightreign.wiki.fextralife.com',
    covers: 'Nightlords and other bosses, Nightfarers (characters), relics, vessels, weapons, items, expeditions, mechanics',
    askAbout: "bosses and what works or doesn't work against them, Nightfarers, weapons, items, flasks, relics, controls, mechanics",
    examples: ['Gladius Beast of Night', 'Wylder', 'Night Aspect', 'Relics'],
  },
  eldenring: {
    game: 'Elden Ring',
    site: 'Fextralife',
    baseUrl: 'https://eldenring.wiki.fextralife.com',
    covers: 'Elden ring: relics, vessels, weapons, items, expeditions, mechanics',
    askAbout: "elden ring and what works or doesn't work against them, weapons, items, flasks, relics, controls, mechanics",
    examples: ['Elden Ring Weapons', 'Elden ring items'],
  },
};
