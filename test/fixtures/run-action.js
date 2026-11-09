// Runs the action's main or post step in its own process, the way the runner does, with the
// download source and the pinned release taken from KAGI_ACTION_FIXTURE. Test use only.
import { main, post, reportFailure } from '../../src/action.js';

const options = JSON.parse(process.env.KAGI_ACTION_FIXTURE ?? '{}');
const step = process.argv[2] === 'post' ? post : main;
step(options).catch(reportFailure);
