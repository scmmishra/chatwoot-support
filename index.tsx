import { Button, definePlugin, Item, List, Messages, Stack, Text, type MessageData } from "@comet/plugin"
import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

/**
 * Chatwoot Support: a Chatwoot inbox, as a Comet plugin. It reads conversations with the `chatwoot` CLI, which must be on
 * the PATH and logged in with `chatwoot auth login`. It only reads. It never replies to or changes a
 * conversation. The inbox sidebar lists the open conversations assigned to you. Picking one opens it as
 * a panel in the view pane and opens the Claude thread kept for it. Turn it on for a project in
 * Comet, with `comet plugin on chatwoot` or in Settings → Plugins.
 *
 * The Chatwoot card links the conversation the tab's thread is about, and its contact, to Chatwoot's
 * web app. It takes the web app's address from the CLI's default account.
 *
 * It reads again when a turn ends in a conversation's thread, since Claude may have changed the
 * conversation. A view that comes on screen reads again if what it shows is stale. While the inbox is on
 * screen it also polls, for changes made outside Comet, such as a customer's reply.
 */

const CONVERSATION_PANEL = "chatwoot.conversation"
const ATTACHMENT_TEXT = "Sent an attachment."
const SECOND_MS = 1000
/** How often the inbox reads again while it is on screen. Turn ends and coming back cover most changes, so this can be slow. */
const POLL_MS = 60 * SECOND_MS
/** How old a read may be before a view that comes on screen reads again. */
const STALE_MS = 15 * SECOND_MS
/** The start of each conversation's thread key. The conversation's id follows it. */
const THREAD_PREFIX = "cw-conv-"

/** Chatwoot's `message_type` values that draw differently. Outgoing messages and templates draw alike. */
const MESSAGE_TYPE = { incoming: 0, activity: 2 } as const
/** A mention as Chatwoot writes it in a message: `[@Name](mention://user/<id>/<name>)`. Comet has no page to open for it. */
const MENTION_LINK = /\[(@[^\]]+)\]\(mention:\/\/[^)]*\)/g

/** The fields the plugin reads from a Chatwoot message, as `chatwoot -o json` prints it. */
interface ChatwootMessage {
  readonly id: number
  readonly content: string | null
  readonly message_type: number
  readonly private: boolean
  /** Seconds since the epoch. */
  readonly created_at: number
  readonly sender?: { readonly name?: string } | null
}

/** The fields the plugin reads from a Chatwoot conversation. `messages` holds only the last message. */
interface Conversation {
  readonly id: number
  readonly account_id: number
  readonly status: string
  readonly priority: string | null
  readonly unread_count?: number
  readonly meta: { readonly sender?: { readonly id: number; readonly name?: string; readonly email?: string } | null }
  readonly messages?: readonly ChatwootMessage[] | null
}

/**
 * The fields the plugin reads from `chatwoot config view -o json`. The released CLI prints its one
 * account as labelled values, such as "Base URL". Its multi-account branch prints each account it is
 * logged in to, and marks the default. The plugin reads either.
 */
interface ChatwootConfig {
  readonly "Base URL"?: string
  readonly accounts?: readonly { readonly base_url: string; readonly default: boolean }[]
}

/** Runs the `chatwoot` CLI with JSON output. A failure carries the CLI's own error, such as a missing login. */
async function chatwoot<T>(args: readonly string[]): Promise<T> {
  try {
    return await Bun.$`chatwoot -o json ${args}`.quiet().json()
  } catch (error) {
    const stderr = error instanceof Bun.$.ShellError ? error.stderr.toString().trim() : ""
    throw new Error(stderr || messageOf(error))
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const toMessage = (message: ChatwootMessage): MessageData => ({
  id: String(message.id),
  // Chatwoot writes messages in Markdown, which Comet draws. A mention draws in bold, as Chatwoot draws it.
  text: message.content?.replace(MENTION_LINK, "**$1**") || ATTACHMENT_TEXT,
  ...(message.sender?.name ? { author: message.sender.name } : {}),
  at: message.created_at * SECOND_MS,
  kind: message.message_type === MESSAGE_TYPE.activity ? "activity" : message.private ? "note" : "message",
  incoming: message.message_type === MESSAGE_TYPE.incoming,
})

const customerOf = (conversation: Conversation) => conversation.meta.sender?.name ?? `#${conversation.id}`

const isStale = (readAt: number | undefined) => readAt === undefined || Date.now() - readAt > STALE_MS

/** The conversation a thread key names, or undefined for a key the plugin did not make. */
const conversationOf = (key: string) => {
  const id = key.startsWith(THREAD_PREFIX) ? Number(key.slice(THREAD_PREFIX.length)) : NaN
  return Number.isInteger(id) ? id : undefined
}

/** The address of a conversation's page in Chatwoot's web app, or of a page under it, such as a contact's. */
const appUrl = (baseUrl: string, conversation: Conversation, path: string) => `${baseUrl}/app/accounts/${conversation.account_id}/${path}`

const transcriptOf = (messages: readonly MessageData[]) =>
  messages.map((message) => `${message.author ?? "Activity"}${message.kind === "note" ? " (private note)" : ""}: ${message.text}`).join("\n")

export default definePlugin((comet) => {
  /** The Extra context setting, which each new conversation thread starts with after the plugin's own words. */
  const readContext = () => String(comet.settings.get("context") ?? "").trim()

  /** `readAt` is when the last read finished, in milliseconds since the epoch. */
  const [inbox, setInbox] = createStore<{ conversations: Conversation[]; loading: boolean; error?: string; readAt?: number }>({ conversations: [], loading: false })
  /** Each conversation's messages, by conversation id, as last read. */
  const [threads, setThreads] = createStore<Record<number, { messages?: MessageData[]; error?: string; readAt?: number }>>({})
  const find = (id: unknown) => inbox.conversations.find((conversation) => conversation.id === id)
  /** Conversations whose panel is on screen, by id, with how many panels show each. */
  const onScreen = new Map<number, number>()

  /**
   * Reads conversations whose panel is on screen again, if the inbox shows a newer last message than
   * the panel holds. A conversation that left the inbox, such as a resolved one, reads again only when
   * its panel comes back on screen.
   */
  const readChanged = () => {
    for (const id of onScreen.keys()) {
      const latest = find(id)?.messages?.at(-1)?.id
      if (latest !== undefined && String(latest) !== threads[id]?.messages?.at(-1)?.id) void readMessages(id).catch(() => undefined)
    }
  }

  // A poll and a turn end can ask at once, so they share one read.
  let inboxRead: Promise<void> | undefined
  /**
   * Reads the inbox. Only a read the user asked for, or the first, shows "Loading…", so polling does not
   * flicker. A failed read keeps the last list and shows the error under it.
   */
  const refreshInbox = (shown = false) => {
    if (shown || inbox.readAt === undefined) setInbox("loading", true)
    inboxRead ??= chatwoot<{ data: { payload: Conversation[] } }>(["convs", "--assignee", "me", "--status", "open"])
      .then((response) => {
        setInbox("conversations", reconcile(response.data.payload, { key: "id" }))
        setInbox({ error: undefined, readAt: Date.now() })
        readChanged()
      })
      .catch((error) => setInbox("error", messageOf(error)))
      .finally(() => {
        setInbox("loading", false)
        inboxRead = undefined
      })
    return inboxRead
  }

  // A sidebar and a panel can ask for the same conversation at once, so they share one read.
  const reading = new Map<number, Promise<MessageData[]>>()
  /** Reads a conversation's messages into `threads`. Chatwoot returns its most recent page of messages. */
  const readMessages = (id: number) => {
    let read = reading.get(id)
    if (!read) {
      // Verb first: older CLIs only turn `conv <id> messages` around when no flag comes before `conv`.
      read = chatwoot<{ payload: ChatwootMessage[] }>(["conv", "messages", String(id)])
        .then((response) => {
          const messages = response.payload.map(toMessage)
          if (!threads[id]) setThreads(id, {})
          setThreads(id, "messages", reconcile(messages, { key: "id" }))
          setThreads(id, { error: undefined, readAt: Date.now() })
          return messages
        })
        .catch((error) => {
          setThreads(id, { error: messageOf(error) })
          throw error
        })
        .finally(() => reading.delete(id))
      reading.set(id, read)
    }
    return read
  }

  // Claude may have replied to, labelled or resolved the conversation in the turn.
  comet.onTurnEnd(({ key }) => {
    const id = conversationOf(key)
    if (id === undefined) return
    void readMessages(id).catch(() => undefined)
    void refreshInbox()
  })

  comet.sidebar("inbox", {
    title: "Inbox",
    view: (ctx) => {
      // The inbox is read when it first comes on screen, not when the plugin starts. It polls only while on screen.
      // The effect follows only `visible`, so a read does not restart the timer.
      createEffect(() => {
        if (!ctx.visible()) return
        if (untrack(() => isStale(inbox.readAt))) void refreshInbox()
        const timer = setInterval(() => void refreshInbox(), POLL_MS)
        onCleanup(() => clearInterval(timer))
      })
      return (
        <Stack grow>
          <Stack direction="row">
            <Text tone="muted">{inbox.loading ? "Loading…" : "Open, assigned to you"}</Text>
            <Button label="Refresh" variant="ghost" disabled={inbox.loading} onClick={() => refreshInbox(true)} />
          </Stack>
          <Show when={inbox.error}>{(error) => <Text tone="muted">{error()}</Text>}</Show>
          <Show when={inbox.conversations.length > 0} fallback={<Show when={!inbox.loading && !inbox.error}><Text tone="muted">No open conversations.</Text></Show>}>
            <List>
              <For each={inbox.conversations}>
                {(conversation) => (
                  <Item
                    title={customerOf(conversation)}
                    subtitle={conversation.messages?.at(-1)?.content || undefined}
                    badge={conversation.unread_count ? { text: String(conversation.unread_count), tint: "blue" } : conversation.priority ? { text: conversation.priority, tint: "orange" } : undefined}
                    selected={ctx.isOpen(CONVERSATION_PANEL, { id: conversation.id })}
                    onSelect={async () => {
                      ctx.open(CONVERSATION_PANEL, { id: conversation.id })
                      // The panel shows a failed read, so the thread just does not open.
                      const messages = await readMessages(conversation.id).catch(() => undefined)
                      if (!messages) return
                      ctx.openThread({
                        key: `${THREAD_PREFIX}${conversation.id}`,
                        title: `#${conversation.id} ${customerOf(conversation)}`,
                        prompt: [
                          `This is Chatwoot conversation #${conversation.id}. Read it with \`chatwoot conv ${conversation.id} messages -o json\` and summarise what the customer needs. Do not reply to the customer or change the conversation without asking me first.`,
                          readContext(),
                        ]
                          .filter(Boolean)
                          .join("\n\n"),
                      })
                    }}
                  />
                )}
              </For>
            </List>
          </Show>
        </Stack>
      )
    },
  })

  comet.panel<{ id: number }>("conversation", {
    title: (params) => {
      const conversation = find(params.id)
      return conversation ? `#${params.id} ${customerOf(conversation)}` : `#${params.id}`
    },
    params: ["id"],
    single: true,
    view: (ctx) => {
      const id = ctx.params.id
      // A panel reads its conversation when it comes on screen with nothing read, or a stale read, such as in a
      // restored tab. While on screen, the inbox's reads tell it when to read again. It shows a failed read.
      createEffect(() => {
        if (!ctx.visible()) return
        if (untrack(() => isStale(threads[id]?.readAt))) void readMessages(id).catch(() => undefined)
        onScreen.set(id, (onScreen.get(id) ?? 0) + 1)
        onCleanup(() => {
          const left = onScreen.get(id)! - 1
          if (left) onScreen.set(id, left)
          else onScreen.delete(id)
        })
      })
      const conversation = () => find(ctx.params.id)
      const thread = () => threads[ctx.params.id]
      return (
        <Stack grow>
          <Stack direction="row">
            <Text tone="strong">{conversation()?.meta.sender?.name ?? `#${ctx.params.id}`}</Text>
            <Text tone="muted">
              #{ctx.params.id}
              {conversation() ? ` · ${conversation()!.status}` : ""}
            </Text>
          </Stack>
          <Show when={thread()?.error}>{(error) => <Text tone="muted">{error()}</Text>}</Show>
          <Show when={thread()?.messages} fallback={<Show when={!thread()?.error}><Text tone="muted">Loading…</Text></Show>}>
            {(messages) => <Messages items={messages()} />}
          </Show>
        </Stack>
      )
    },
  })

  // The web app's address belongs to the CLI's default account, the one the inbox reads. It is read once,
  // and again after a failed read, such as before `chatwoot auth login`.
  const [baseUrl, setBaseUrl] = createSignal<{ url?: string; error?: string }>()
  const readBaseUrl = () => {
    const read = untrack(baseUrl)
    if (read && !read.error) return
    setBaseUrl({})
    chatwoot<ChatwootConfig>(["config", "view"])
      .then((config) => {
        const url = config.accounts ? config.accounts.find((account) => account.default)?.base_url : config["Base URL"]
        setBaseUrl(url ? { url } : { error: "The chatwoot CLI names no account to link to. Log in with `chatwoot auth login`, or pick one with `chatwoot use <name>`." })
      })
      .catch((error) => setBaseUrl({ error: messageOf(error) }))
  }

  /** Conversations the card read itself, by id, for those not in the inbox, such as a resolved one. */
  const [viewed, setViewed] = createStore<Record<number, Conversation>>({})
  const viewing = new Set<number>()
  const readConversation = (id: number) => {
    if (viewing.has(id)) return
    viewing.add(id)
    chatwoot<Conversation>(["conv", "view", String(id)])
      .then((conversation) => setViewed(id, conversation))
      .catch(() => undefined)
      .finally(() => viewing.delete(id))
  }

  comet.card("links", {
    title: "Chatwoot",
    view: (ctx) => {
      const id = () => conversationOf(ctx.thread() ?? "")
      const conversation = () => {
        const found = id()
        return found === undefined ? undefined : (find(found) ?? viewed[found])
      }
      // The card reads only while on screen, and only what the inbox does not hold.
      createEffect(() => {
        if (!ctx.visible()) return
        const found = id()
        if (found === undefined) return
        readBaseUrl()
        if (untrack(() => !find(found) && !viewed[found])) readConversation(found)
      })
      return (
        <Show when={conversation()}>
          {(shown) => (
            <Show when={baseUrl()?.url} fallback={<Show when={baseUrl()?.error}>{(error) => <Text tone="muted">{error()}</Text>}</Show>}>
              {(url) => (
                <Stack gap={0}>
                  <Item
                    title={`Conversation #${shown().id}`}
                    href={appUrl(url(), shown(), `conversations/${shown().id}`)}
                  />
                  <Show when={shown().meta.sender}>
                    {(contact) => (
                      <Item
                        title={contact().name ?? `Contact #${contact().id}`}
                        subtitle={contact().email || undefined}
                        href={appUrl(url(), shown(), `contacts/${contact().id}`)}
                      />
                    )}
                  </Show>
                </Stack>
              )}
            </Show>
          )}
        </Show>
      )
    },
  })

  comet.setup("chatwoot", { title: "Chatwoot Support", sidebar: "chatwoot.inbox" })
})
