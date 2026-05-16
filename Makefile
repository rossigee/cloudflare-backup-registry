.PHONY: screenshots

BASE_URL = http://localhost:8787
API_TOKEN = test-api-token

screenshots:
	@echo "==> Starting dev server..."
	@npx wrangler dev --env testing > /tmp/wrangler-screenshots.log 2>&1 & echo $$! > /tmp/wrangler-screenshots.pid
	@until curl -sf $(BASE_URL)/health > /dev/null 2>&1; do sleep 1; done
	@echo "==> Seeding test data..."
	@curl -sf -X POST $(BASE_URL)/v1/backup-runs \
	  -H "Authorization: Bearer $(API_TOKEN)" -H "Content-Type: application/json" \
	  -d '{"run_id":"ss-001","job_name":"postgres-daily","agent_id":"agent-db-01","start_time":"2026-05-16T02:00:00Z","end_time":"2026-05-16T02:04:33Z","status":"success","bytes_backed_up":1073741824,"encryption_status":"encrypted","backup_url":"https://s3.example.com/postgres-daily.tar.gz"}' > /dev/null
	@curl -sf -X POST $(BASE_URL)/v1/backup-runs \
	  -H "Authorization: Bearer $(API_TOKEN)" -H "Content-Type: application/json" \
	  -d '{"run_id":"ss-002","job_name":"postgres-daily","agent_id":"agent-db-01","start_time":"2026-05-15T02:00:00Z","end_time":"2026-05-15T02:03:51Z","status":"success","bytes_backed_up":1071234567,"encryption_status":"encrypted"}' > /dev/null
	@curl -sf -X POST $(BASE_URL)/v1/backup-runs \
	  -H "Authorization: Bearer $(API_TOKEN)" -H "Content-Type: application/json" \
	  -d '{"run_id":"ss-003","job_name":"mysql-weekly","agent_id":"agent-db-02","start_time":"2026-05-16T22:00:00Z","end_time":"2026-05-16T22:45:00Z","status":"failure","bytes_backed_up":0,"encryption_status":"unencrypted","error":"Connection refused: unable to reach mysql host on port 3306"}' > /dev/null
	@curl -sf -X POST $(BASE_URL)/v1/backup-runs \
	  -H "Authorization: Bearer $(API_TOKEN)" -H "Content-Type: application/json" \
	  -d '{"run_id":"ss-004","job_name":"files-nightly","agent_id":"agent-files-01","start_time":"2026-05-16T01:00:00Z","end_time":"2026-05-16T01:12:07Z","status":"partial","bytes_backed_up":524288000,"encryption_status":"partial","error":"3 files skipped due to permission denied"}' > /dev/null
	@echo "==> Capturing screenshots..."
	@npx playwright screenshot --full-page $(BASE_URL)/ docs/screenshot.png
	@npx playwright screenshot --full-page $(BASE_URL)/docs docs/docs-screenshot.png
	@echo "==> Stopping dev server..."
	@kill $$(cat /tmp/wrangler-screenshots.pid) 2>/dev/null && rm -f /tmp/wrangler-screenshots.pid /tmp/wrangler-screenshots.log
	@echo "==> Done. docs/screenshot.png and docs/docs-screenshot.png updated."
