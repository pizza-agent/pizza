import { DurableObject } from "cloudflare:workers";
import worker, { GoogleOAuthSession as Session } from "./worker.mjs";

export class GoogleOAuthSession extends DurableObject {
	constructor(ctx, env) { super(ctx, env); this.session = new Session(ctx, env); }
	fetch(request) { return this.session.fetch(request); }
	alarm() { return this.session.alarm(); }
}
export default worker;
