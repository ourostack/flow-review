// An app that starts and never announces itself: it records its pid where the test asks, then waits.
import fs from 'node:fs';

fs.writeFileSync(process.env.FLOW_REVIEW_STALL_PID, String(process.pid));
setInterval(() => {}, 1000);
