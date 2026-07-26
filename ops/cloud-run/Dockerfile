FROM node:22.18-bookworm-slim
COPY --chown=node:node lib /app/lib
WORKDIR /app/lib/emsenn/services/561-group/services/red-cup-engineering/services/software-development-services-section/services/software-mission-execution-service
RUN npm install -g npm@11 && rm -f package-lock.json && npm install --omit=dev --install-links && npm cache clean --force && node --check bin/serve-a2a.mjs
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 A2A_TASK_STORE_ROOT=/var/lib/software-mission-execution/a2a/tasks SOFTWARE_MISSION_EXECUTION_DATA_ROOT=/var/lib/software-mission-execution/settlement
USER node
EXPOSE 8080
CMD ["node", "bin/serve-a2a.mjs"]
