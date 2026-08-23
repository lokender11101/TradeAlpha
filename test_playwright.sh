#!/bin/bash

# Kill any existing servers
pkill -f 'next'
pkill -f 'node.*main.api.ts'

# Start API and Web servers in background
export MOCK_TIME=true
export MOCK_TIME_VALUE="2023-10-10T05:00:00Z"
npm run dev:all > dev_servers.log 2>&1 &
SERVER_PID=$!

# Wait for API and Web to be ready
echo "Waiting for API (4000)..."
while ! curl -s http://localhost:4000/health > /dev/null; do sleep 1; done
echo "API is up!"

echo "Waiting for Web (3000)..."
while ! curl -s http://localhost:3000 > /dev/null; do sleep 1; done
echo "Web is up!"

# Seed DB
echo "Seeding DB..."
npm run seed:e2e --workspace=api

# Run Playwright
echo "Running Playwright Chromium..."
cd apps/web
npx playwright test --project=chromium
CHROMIUM_STATUS=$?

echo "Running Playwright Firefox..."
npx playwright test --project=firefox
FIREFOX_STATUS=$?

cd ../../

# Kill servers
kill $SERVER_PID
pkill -f 'next'
pkill -f 'node.*main.api.ts'

echo "Chromium: $CHROMIUM_STATUS"
echo "Firefox: $FIREFOX_STATUS"
