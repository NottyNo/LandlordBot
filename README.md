# NyraNetworkBot

Personal Discord bot built with [discord.js](https://discord.js.org/) for a friends' server - moderation and utility commands.

## Tests and maintenance

Run `npm test` for the regression tests. They use in-memory SQLite databases and mocked Discord calls; they do not read credentials, connect to Discord, or change `data/nyra.db`.

To repair previously incorrect levels, stop the bot and run `node src/scripts/fixLevels.js`. This recalculates levels from saved XP without logging into Discord. It cannot recover XP that was previously lost.

Giveaway durations accept whole units (`1d12h`, `30m`, `10s`), from 10 seconds to 365 days. Winner selection uses an unbiased shuffle. Failed result deliveries retry every 30 seconds with the same saved winners, including after a restart. `/giveaway end` can retry a pending delivery immediately; rerolls wait until the original result is announced.

The next startup automatically adds the announcement tracking column without deleting existing data. Previously ended giveaways are treated as already announced to avoid replaying old results; any historical missing announcements need manual review. Run one bot process per database. A crash after Discord accepts an announcement but before it is saved locally can cause a duplicate announcement on retry.

##  Features

###  Moderation
- `/banUser {user} [reason]` - Ban a user from the server, with an optional reason
- `/timeoutUser {user} [reason]` - Temporarily timeout a user
- `/warn {user} [reason]` - Warn a user
- `/unwarn {user} [reason]` - Remove warn a user
- `/cleanChat {amount}` - Removes a certain amount of most recent messages from a chat
- `/addXp {user} {amount}` - Adds XP to a certain user
- `/removexp {user} {amount}` - Removes XP from a certain user
- `/mute {user}` - Voice mutes a user for Voice Chats

###  Utility
- `/leaderboard` - Shows a leaderboard with the top 10 people with the most XP
- `/rank [user]` - Shows rank info about yourself or another user
- `/setupstats` - Sets up stat channels for the Server (Members, Bots, Server IP, discord link)
- `/refreshstats` - Force refreshes stat channels in case of change in the config
- `/server` - Replies with info about the servers Minecraft IP
- `/user {user}` - Displays information about a certain user like Account Creation Date, User ID, ...
- `/warnings {user}` - Displays all warnings a certain user has

###  In progress
- **Giveaway System** - Creating Giveaways where users who might meet certain conditions can interact and participate
- **Welcome Messages** - A nice greeting once a user joins the server

## Roadmap

- [x] Leveling system (XP gain, level-ups, leaderboard)
- [x] Additional moderation tools
- [x] More utility commands
- [x] /cleanup x — takes in a number and removes that amount of most recent sent messages
- [ ] Giveaway functionality - Create, Delete and Manage Giveaways
- [ ] Welcome Messages
