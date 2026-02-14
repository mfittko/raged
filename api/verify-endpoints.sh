#!/bin/bash
# Manual verification script for Phase 4 API endpoints
# This script demonstrates how to test the new enrichment and graph endpoints

API_URL="${API_URL:-http://localhost:8080}"

echo "=== Phase 4 API Endpoint Verification ==="
echo ""

# 1. Test enrichment status endpoint
echo "1. Testing GET /enrichment/status/:baseId"
echo "   curl -X GET \"$API_URL/enrichment/status/test-repo:file.ts\""
echo ""

# 2. Test enrichment stats endpoint
echo "2. Testing GET /enrichment/stats"
echo "   curl -X GET \"$API_URL/enrichment/stats\""
echo ""

# 3. Test enrichment enqueue endpoint
echo "3. Testing POST /enrichment/enqueue"
echo "   curl -X POST \"$API_URL/enrichment/enqueue\" \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"collection\": \"docs\", \"force\": false}'"
echo ""

# 4. Test query with graph expansion
echo "4. Testing POST /query with graphExpand"
echo "   curl -X POST \"$API_URL/query\" \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"query\": \"authentication\", \"graphExpand\": true}'"
echo ""

# 5. Test graph entity endpoint
echo "5. Testing GET /graph/entity/:name"
echo "   curl -X GET \"$API_URL/graph/entity/AuthService\""
echo ""

echo "=== Prerequisites ==="
echo "- Start services: docker compose up -d"
echo "- Or with enrichment: docker compose --profile enrichment up -d"
echo "- Ensure Neo4j is populated with test data for graph endpoints"
echo ""
echo "=== Expected Behaviors ==="
echo "- /enrichment/* endpoints return 0 values when enrichment is disabled"
echo "- /graph/* endpoints return empty/error when Neo4j is not configured"
echo "- All endpoints should return valid JSON responses"
echo "- Schema validation should reject invalid requests with 400 status"
