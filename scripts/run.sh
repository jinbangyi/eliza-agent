set -e

export USE_CHARACTER_STORAGE=true

tmux new -s client -d \
"export OPENAI_API_KEY='$OPENAI_API_KEY' && \
pnpm dev -- --host"
