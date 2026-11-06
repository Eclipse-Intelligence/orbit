import { isReadMessage, type ReadReply } from "./messages";
import { readPage } from "./parsers";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isReadMessage(message)) return;
  let reply: ReadReply;
  try {
    reply = { ok: true, result: readPage(document, location.href, message.what) };
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : "Couldn't read this page." };
  }
  sendResponse(reply);
});
