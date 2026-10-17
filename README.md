# X Blocker

Mass-block accounts on X (Twitter), safely. A browser extension for **Firefox**
and **Chrome**.

X Blocker is an independent project and is not affiliated with or endorsed by X Corp.

## Features

- **Block a whole list.** Open followers, following, likes, reposts, quotes,
  replies, search results, list members or followers, or community members on
  x.com. The X Blocker panel at the bottom offers **Review**: you see exactly
  that list's accounts, untick anyone you want to keep, and block the rest.
- **Block buttons everywhere.** Every account gets its own **Block** button next
  to X's Follow button, and every post gets one next to the author.
- **Collect for later.** Press **Collect** to save a list's accounts, gather
  several lists, then review and block them all at once. **Scroll list** loads
  long lists for you.
- **Import.** Paste or upload @handles, profile links, user IDs or a CSV.
- **Runs in the background.** Accounts are blocked one by one. Pause and resume
  anytime, even after closing the browser.
- **Dashboard.** Browse, filter and export your collected, queued and blocked
  accounts, and see a log of everything that happened.

## Safety

- **Stays under X's limits.** A daily limit (450 blocks per 24 hours by default)
  and human-like pacing (about 6 seconds per block) keep your account safe. If X
  says "too many requests", the queue waits and then resumes by itself.
- **Protects your friends.** Never blocks you, and by default skips people you
  follow and people who follow you. You can also skip verified accounts and keep
  a never-block list.
- **Blocks only who you meant.** Look-alike display names and @mentions can't
  redirect a block to someone else.

## Privacy

- Everything stays on your own device, in your browser's own storage. There is
  no analytics, no server, no account and no tracking.
- Private pages (messages, notifications, settings) are never read.
- Pressing **Collect** only saves those accounts in the extension's own storage
  on your device. Nothing is uploaded, sent or shared anywhere. It happens only
  when you press it, and friends or people you merely read about are never saved.
- Collected profiles are forgotten after 30 days, and **Delete all data** in
  Settings wipes them in one click.

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

For bigger jobs, press **Collect** on several lists, then open the
**Dashboard** from the extension's toolbar button to review, queue and block
them. You can keep browsing while it works. Just keep one x.com tab open.

## Contributing

Bug reports and ideas are welcome in
[Issues](https://github.com/bitcooker/x-blocker/issues). To work on the code,
see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[GPL-3.0-or-later](LICENSE). You may use, modify and share this code, as long
as you share your changes under the same license.
