// Local runs read settings (model API keys etc.) from .env if there is one; see
// .env.example. Variables already set in the shell win, so `npm run demo` keeps
// its rules engine. Imported first by server.ts; Lambda gets its settings from
// the function configuration instead.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file: environment variables only
}
