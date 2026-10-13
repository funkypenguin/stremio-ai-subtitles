# AI Subtitles

A Stremio addon that translates English subtitles into your language with your own AI.

- Works with OpenAI, Anthropic (Claude), Google Gemini, Groq, OpenRouter, DeepSeek, Mistral,
  xAI (Grok) or any OpenAI-compatible endpoint.
- 187 languages, the same ones Stremio shows in its subtitle menu.
- Translations aimed at ordinary viewers: technical jargon (police, firefighters, medical, legal)
  is turned into words anyone understands.
- Your API key is stored only inside your install link, encrypted. No accounts.

## Install

Open the addon's `/configure` page, pick your AI and language, and press **Install in Stremio**.

## Self-hosting

Requires Node.js 18+. No dependencies.

```sh
cp .env.example .env   # set CONFIG_SECRET and PUBLIC_URL
set -a; . ./.env; set +a
node server.js
```

Put it behind HTTPS: Stremio apps only load addons over HTTPS (except on localhost).

### BeamUp

```sh
npm install -g beamup-cli
beamup config a.baby-beamup.club <your-github-username>
beamup init ai-subtitles
beamup secrets CONFIG_SECRET "$(openssl rand -hex 32)"
beamup secrets PUBLIC_URL https://<your-project-url>   # printed by the first deploy
beamup secrets REAL_IP_HEADER x-forwarded-for
beamup
```

BeamUp authenticates you with the public SSH keys of your GitHub account, so the key you deploy
from must be added to GitHub. The disk is reset on every deploy, so the translation cache starts
empty after each update.

## Notice

This addon only translates subtitle text. It does not host, link or stream any video.
Source subtitles come from OpenSubtitles through Stremio's public addon.

## Credits

Language list from [Stremio/nodejs-langs](https://github.com/Stremio/nodejs-langs) (MIT).
