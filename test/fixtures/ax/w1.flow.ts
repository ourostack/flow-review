// An agent flow written against a product repository's own types (define.ts), not the engine's: the engine runs it
// unchanged. It runs against a stand-in mock and CLI (mock.mjs, cli.mjs) named by --target, with the surface's app
// from flow-review.config.json.
import { defineFlow } from "./define.ts";

const READ = 2500;

export default defineFlow({
  id: "W1",
  surface: "agent-cli",
  title: "Morning triage: what needs you, what happened and every thread, ranked with links",
  source: "example: morning triage",
  rubric: ["discoverable", "predictable", "honest", "fast", "beautiful"],
  readOnly: true,
  known: { "discoverable.listed": "https://example.com/issues/1" },
  steps: [
    { id: "today", run: ["today", "--json"], expect: { exit: 0, jsonShape: ["attention.top[].ref", "attention.top[].why", "attention.top[].from", "nextCommands[]"], maxMs: READ, maxBytes: 8000 }, save: { first: "attention.top[0].ref" } },
    { id: "activity", run: ["activity", "--json"], expect: { exit: 0, jsonShape: ["counts.unseen", "items[]"], maxMs: READ } },
    {
      id: "attention",
      run: ["attention", "--json"],
      expect: { exit: 0, jsonShape: ["[].threadTitle", "[].why", "[].messageId"], fields: { "[].link": { re: "^https://example\\.com/inbox/" } }, maxMs: READ },
      fix: "give each attention item its ref (<thread>#<message>) and link, as today's top items and look's messages have",
      known: "https://example.com/issues/2",
    },
    { id: "threads", run: ["threads", "--json"], expect: { exit: 0, jsonShape: ["[].shortId", "[].title", "[].kind", "[].link"], maxMs: READ } },
    { id: "open-first", run: ["look", "{first}", "--json"], expect: { exit: 0, jsonShape: ["messages[0].ref", "messages[0].link", "messages[0].sender.displayName"], maxMs: READ } },
  ],
});
