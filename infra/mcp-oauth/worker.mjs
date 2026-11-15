import { metadataResponse } from "./metadata.mjs";

export default {
	fetch(request) {
		return metadataResponse(request);
	},
};
