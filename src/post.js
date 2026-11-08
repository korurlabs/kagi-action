// Entry point of the post step (runs.post in action.yml). The logic lives in action.js.
import { post, reportFailure } from './action.js';

post().catch(reportFailure);
