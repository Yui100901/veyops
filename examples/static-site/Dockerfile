FROM node:22
WORKDIR /app
COPY dist ./dist
COPY server.js ./server.js
USER node
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=2s CMD node -e "fetch('http://127.0.0.1:8080').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
