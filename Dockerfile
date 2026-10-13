FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=7311

# no dependencies: just the code and the language list
COPY package.json server.js languages.json ./
RUN mkdir -p cache && chown node:node cache

USER node
EXPOSE 7311
# finished translations (mount a volume so they survive updates)
VOLUME /app/cache

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
