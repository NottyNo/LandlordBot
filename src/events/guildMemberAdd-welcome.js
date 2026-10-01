const { Events, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const path = require('node:path');
const db = require('../database/db');
const { colors: { embed: embedColor } } = require('../config/colors.json');

// Resolves relative to THIS file's location, not the process's working directory
const WELCOME_IMAGE_PATH = path.join(__dirname, '../images/welcome.png');

module.exports = {
    name: Events.GuildMemberAdd,
    async execute(member) {
        const settings = db.prepare(`
            SELECT welcomeChannelId FROM guild_settings WHERE guildId = ?
        `).get(member.guild.id);

        if (!settings?.welcomeChannelId) {
            return;
        }

        const channel = member.guild.channels.cache.get(settings.welcomeChannelId);
        if (!channel) {
            console.warn(`Welcome channel (${settings.welcomeChannelId}) not found in guild ${member.guild.id}.`);
            return;
        }

        const welcomeText = `Welcome ${member} to **${member.guild.name}**! We're glad to have you here.`;

        const embed = new EmbedBuilder()
            .setDescription(welcomeText)
            .setColor(embedColor);

        try {
            const attachment = new AttachmentBuilder(WELCOME_IMAGE_PATH, { name: 'welcome.gif' });
            embed.setImage('attachment://welcome.gif');

            await channel.send({ embeds: [embed], files: [attachment] });
        } catch (error) {
            console.warn('Welcome gif could not be loaded, sending without it:', error.message);
            await channel.send({ embeds: [embed] }).catch(() => {});
        }
    },
};