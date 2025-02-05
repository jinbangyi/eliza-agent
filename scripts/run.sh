set -e

export USE_CHARACTER_STORAGE=true

# start agent
nvm use 23
pnpm install
pnpm dev

# start client
