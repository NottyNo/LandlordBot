const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const db = require('../../database/db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setlevelchannel')
        .setDescription('Set the channel where level-up messages are sent.')
        .addChannelOption((option) =>
            option
                .setName('channel')
                .setDescription('The channel to send level-up messages in')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async execute(interaction) {
        const channel = interaction.options.getChannel('channel');

        db.prepare(`
            INSERT INTO guild_settings (guildId, levelUpChannelId)
            VALUES (?, ?)
            ON CONFLICT(guildId) DO UPDATE SET levelUpChannelId = excluded.levelUpChannelId
        `).run(interaction.guild.id, channel.id);

        await interaction.reply({
            content: `Level-up messages will now be sent in ${channel}.`,
            flags: MessageFlags.Ephemeral,
        });
    },
};