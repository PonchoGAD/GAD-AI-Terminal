/**
 * Text cleaning utilities for trend-launcher LLM calls.
 * Goal: reduce input tokens 65-80% while preserving semantic content.
 */

const URL_RE      = /https?:\/\/\S+/g;
const MENTION_RE  = /@\w+/g;
const HASHTAG_RE  = /#(\w+)/g;     // keep the word, strip the hash
const SPECIAL_RE  = /[^\w\s,.!?'-]/g;
const SPACES_RE   = /\s{2,}/g;

/**
 * Strip URLs, @mentions, special chars; collapse whitespace; cap at maxChars.
 * Keeps hashtag words (the part after #) to preserve narrative signal.
 */
export function cleanAndSlimTrendText(raw: string, maxChars = 250): string {
  return raw
    .replace(URL_RE,      '')
    .replace(MENTION_RE,  '')
    .replace(HASHTAG_RE,  '$1')      // "#Bitcoin" → "Bitcoin"
    .replace(SPECIAL_RE,  ' ')
    .replace(SPACES_RE,   ' ')
    .trim()
    .slice(0, maxChars);
}
