// Runs before every test file (vitest setupFiles).
import { installNetworkGuard } from './networkGuard.js';

installNetworkGuard();
