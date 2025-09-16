name: Run Telegram Checklist Bot

on:
  schedule:
    - cron: '30 1 * * *'  # 09:30 AM SGT (01:30 UTC)
    - cron: '0 8 * * *'   # 04:00 PM SGT (08:00 UTC)
  workflow_dispatch:
    inputs:
      duration_minutes:
        description: "How long to keep the bot online (minutes)"
        required: false
        default: "30"
      announce_chat_id:
        description: "Chat ID to announce wake/reminders to (optional)"
        required: false
        default: ""
      verbose:
        description: "Enable extra logging"
        required: false
        default: "false"
      skip_commit:
        description: "Skip committing checklists.json after run"
        required: false
        default: "false"

concurrency:
  group: checklist-bot
  cancel-in-progress: true

jobs:
  run-bot:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    permissions:
      contents: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Restore existing checklists.json
        shell: bash
        run: |
          set -euo pipefail
          git fetch origin main
          if git show origin/main:checklists.json >/dev/null 2>&1; then
            git show origin/main:checklists.json > checklists.json
            echo "Restored checklists.json from main."
          else
            echo "{}" > checklists.json
            echo "Initialized new checklists.json."
          fi

      - name: Run bot (interactive for duration)
        env:
          BOT_TOKEN: ${{ secrets.BOT_TOKEN }}
          DROP_PENDING: 'true'
          CHAT_ID: '${{ github.event.inputs.announce_chat_id || secrets.CHAT_ID }}'  # quoted for negative IDs
          DURATION_MINUTES: ${{ github.event.inputs.duration_minutes || '30' }}
          VERBOSE: ${{ github.event.inputs.verbose || 'false' }}
        run: node checklist.js

      - name: Commit and push updated checklist
        if: ${{ github.event.inputs.skip_commit != 'true' }}
        shell: bash
        run: |
          set -euo pipefail
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add checklists.json
          git commit -m "Update checklist data [skip ci]" || echo "No changes to commit"
          git push origin HEAD:main
