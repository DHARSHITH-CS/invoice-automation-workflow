/**
 * Runs NocoDB directly as a Node.js process (no Docker) - used only because
 * Docker Desktop hit an unrecoverable environment bug on this machine.
 * See NocoDB's own "Node.js App" deployment docs for this pattern.
 */
const express = require('express');

async function main() {
  const { Noco } = require('nocodb');
  const app = express();
  const port = process.env.PORT || 8090;
  const httpServer = app.listen(port, () => {
    console.log('NocoDB listening on port', port);
  });
  httpServer.on('error', (err) => {
    console.error('NocoDB HTTP server error:', err);
    process.exit(1);
  });
  app.use(await Noco.init({}, httpServer, app));
}

main().catch(err => {
  console.error('NocoDB failed to start:', err);
  process.exit(1);
});
