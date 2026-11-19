# Chatwoot Support

A Comet plugin. It lists the open Chatwoot conversations assigned to you. Picking one opens the conversation in a panel and an agent thread kept for it. A card links the conversation and its contact to Chatwoot.

It only reads. It never replies to a customer or changes a conversation.

## Needs

- The `chatwoot` CLI on your PATH, logged in with `chatwoot auth login`.

## Install

```sh
comet plugin add @scmmishra/chatwoot-support
comet plugin on chatwoot          # in your Chatwoot checkout
```

Then open the "Chatwoot Support" setup from the palette.

## Your context

Each conversation's thread starts with a short prompt. To tell the agent more, such as which tools and access you have, write it in `~/.comet/chatwoot-support.md`. The plugin adds that file's text to every new thread.
