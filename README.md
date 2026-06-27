# Slack that Theo wants

Idea from Theo (https://x.com/theo/status/2069621429189161350 / https://www.youtube.com/watch?v=wEAb0x3wTRc). Note that Theo has no endorsement on this project (yet).

## Rationale - Slack alternative

Slack has extremely strong user lock-in—its connection system (cross-company shared channels) is very powerful, and almost all of Theo’s Slack channels exist to communicate with other companies. But Slack itself is terrible:

-  No inline replies; you have to create a thread
-  Threads sink into history and are hard to find even when active
-  You can’t reply to individual messages inside a thread
-  Poor code block experience

And worse: agents are completely awkward in Slack. Slack is designed for sending messages, and that’s it. It’s not designed for reading messages, determining work priorities, or getting status updates.

**What Theo wants (inspired by Facebook Workplace)**
-  Posts as the basic unit, sitting somewhere between channels and topics, a more sensible abstraction than Slack’s message/thread model
-  First-level comments and nested replies under each post
-  The ability to reply to different people in comments without clogging the main post
-  Old posts with new comments get bumped back to the top of the feed (this is the most important feature)
-  Unlimited nesting and logically organized discussion threads
-  Agents can enter in a logical way and become part of the same control plane

Facebook Workplace is the best context-management tool Theo has ever seen. The post → comment → subcomment nesting structure works well for both humans and agents. But Meta has shut it down.

Theo even started building this himself, but he was too busy to finish it. Theo wants something like Slack, but that feels more like Facebook, and is easy to interact with through agents. Imagine combining it with Hermes Agent—you post what you want to do in a group, and when the agent replies to the post, it gets bumped back to the top. Theo hopes this becomes an open-source standard, not to replace Slack outright, but to gradually replace it.

