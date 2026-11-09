// Entry point of the main step (runs.main in action.yml). The logic lives in action.js.
import { main, reportFailure } from './action.js';

main().catch(reportFailure);
