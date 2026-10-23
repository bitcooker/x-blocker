# X Blocker

Mass-block accounts on X (Twitter), safely. A browser extension for **Firefox**
and **Chrome**.

X Blocker is an independent project and is not affiliated with or endorsed by X Corp.

## Features

- **Block a whole list.** Open followers, following, likes, reposts, quotes,
  replies, search results, list members or followers, or community members on
  x.com. The X Blocker panel at the bottom offers **Review**: you see exactly
  that list's accounts, untick anyone you want to keep, and block the rest.
  Prefer no review? Turn off **Require review before blocking a list** in
  Settings and the button becomes **Block**, which queues everyone in the list
  at once (except people you follow or who follow you, and accounts already
  queued or blocked). Reviewing stays one click away.
- **Block buttons.** Accounts get a **Block** button next to X's Follow
  button, and posts get one next to the ⋯ menu. By default it asks first and
  blocks right away, like X does. In Settings you can make it add the account
  to the queue instead, so single blocks follow the same pace and limits as
  lists (today's clicks are grouped in one **Quick blocks** batch). Show the
  buttons everywhere, only on lists, or turn them off.
- **Long lists, a batch at a time.** The panel shows how many accounts are
  loaded (and the list's size for followers and following). **Load all**
  scrolls the list to its end for you. Or review what is loaded, block, scroll,
  and review again: accounts already queued or blocked are left out.
- **Batches you can undo.** Every list you block or import is a batch. Right
  after blocking, **Undo** takes it back out of the queue. Later, **Undo** on
  the dashboard's Batches page unblocks everyone in it. Single accounts can be
  unblocked on the Blocked page.
- **Import and share lists.** Paste or upload @handles, profile links, user IDs
  or a CSV. The Blocked and Queue pages export a CSV with IDs and @handles that
  anyone can import, and IDs keep working after people change their handle.
- **Runs in the background.** Accounts are blocked one by one while you keep
  browsing. Pause and resume anytime, even after closing the browser. After a
  rate limit, the queue resumes by itself, and moves to another x.com tab if
  its tab is gone.
- **Toolbar menu and dashboard.** The toolbar menu shows the queue, the time
  left, the safety limits, and what you can do on the current tab. The
  dashboard has a Home overview and pages for Import, Batches, Queue, Blocked
  and Settings. **Details** in the panel on x.com opens the queue there.

- **In your language.** English, فارسی (Persian), العربية (Arabic), Deutsch,
  Español, Français and Türkçe, with full right-to-left layouts for Persian
  and Arabic. It follows your browser's language, or pick one in Settings.

## Safety

- **Stays under X's limits.** Safety limits (150 blocks per hour and 1,000 per
  24 hours by default) and human-like pacing (about 6 seconds per block) keep
  blocking spread out. If X says "too many requests", the queue waits until
  X's limit resets, then resumes by itself.
- **Protects your friends.** Never blocks you, and by default skips people you
  follow and people who follow you. You can also skip verified accounts and keep
  a Never block list, which also catches people who changed their handle.
- **Blocks only who you meant.** Look-alike display names and @mentions can't
  redirect a block to someone else.

## Privacy

- Everything stays on your own device, in your browser's own storage. There is
  no analytics, no server, no account and no tracking.
- Private pages (messages, notifications, settings) are never read.
- Only the accounts you queue and the ones you block are saved, in the
  extension's own storage on your device. Nothing is uploaded, sent or shared
  anywhere, and people you merely read about are never saved.
- **Delete all data** in Settings wipes everything in one click.

## Install

**Firefox (140+):** install from
[addons.mozilla.org](https://addons.mozilla.org/firefox/addon/x-blocker/).
Updates arrive automatically.

**Chrome, Edge, Brave, Vivaldi, Opera:** the extension is not in the Chrome Web
Store yet.

1. Download `x-blocker-chrome-<version>.zip` from the
   [latest release](https://github.com/bitcooker/x-blocker/releases/latest)
   and extract it to a folder you will keep.
2. Open `chrome://extensions` (`edge://extensions` in Edge) and switch on
   **Developer mode**.
3. Click **Load unpacked** and select the extracted folder.

To update, replace the folder's contents with the new release and click the
reload icon on the extension's card. Your settings and data are kept.

## How to use

1. Log in to x.com and open a list of accounts, for example someone's followers,
   the likes on a post, or a list's members.
2. Open the X Blocker panel at the bottom of the page and press **Review**.
3. Untick anyone you want to keep and press **Block**.

Accounts are blocked in the background while you keep browsing; just keep one
x.com tab open. To block a single account, click its **Block** button. The
**Dashboard** (from the extension's toolbar button) shows your batches and the
queue, and lets you import, export and undo blocks.

## Contributing

Bug reports and ideas are welcome in
[Issues](https://github.com/bitcooker/x-blocker/issues). To work on the code,
see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[GPL-3.0-or-later](LICENSE). You may use, modify and share this code, as long
as you share your changes under the same license.

Persian and Arabic text uses [Vazirmatn](https://github.com/rastikerdar/vazirmatn)
by Saber Rastikerdar, under the SIL Open Font License
([extension/fonts/Vazirmatn-OFL.txt](extension/fonts/Vazirmatn-OFL.txt)).
