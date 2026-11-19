/**
 * The demo page at `/`: the user's phone with the agent's chat, the requests between the agent,
 * Couch Tour and BotShield as they happen (Atlas-style), and the account holder's phone. The page
 * is plain HTML (page.html), bundled as text.
 */
import page from './page.html';

export function demoPage(): string {
  return page;
}
