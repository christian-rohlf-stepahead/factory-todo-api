#!/bin/sh
set -eu

helm upgrade --install todo-api /chart \
  --namespace "$FACTORY_NAMESPACE" \
  --wait --timeout 5m \
  --set "api.image=$FACTORY_IMAGE_TODO_API_API" \
  --set "api.host=$FACTORY_HOST_TODO_API" \
  --set "web.image=${FACTORY_IMAGE_TODO_WEB_WEB:-}" \
  --set "web.host=${FACTORY_HOST_TODO_WEB:-}" \
  --set "webTerminal.image=${FACTORY_IMAGE_TODO_CLI_WEB:-}" \
  --set "webTerminal.host=${FACTORY_HOST_TODO_CLI:-}"
