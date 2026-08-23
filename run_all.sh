#!/bin/bash



echo "Running npm run test:all..."
npm run test:all
CODE_TEST_ALL=$?

echo "Running npm run typecheck:all..."
npm run typecheck:all
CODE_TYPECHECK=$?

echo "Running npm run lint:all..."
npm run lint:all
CODE_LINT=$?

echo "Running npm run build:web..."
npm run build --workspace=web
CODE_BUILD=$?

echo "Running npm run test:e2e..."
npm run test:e2e
CODE_TEST_E2E=$?

cd apps/web

echo "Running npx playwright test --project=chromium..."
npx playwright test --project=chromium
CODE_CHROMIUM=$?

echo "Running npx playwright test --project=firefox..."
npx playwright test --project=firefox
CODE_FIREFOX=$?

cd ../../

echo ""
echo "=== EXIT CODES ==="
echo "test:all      : $CODE_TEST_ALL"
echo "test:e2e      : $CODE_TEST_E2E"
echo "typecheck:all : $CODE_TYPECHECK"
echo "lint:all      : $CODE_LINT"
echo "build:web     : $CODE_BUILD"
echo "Chromium      : $CODE_CHROMIUM"
echo "Firefox       : $CODE_FIREFOX"

