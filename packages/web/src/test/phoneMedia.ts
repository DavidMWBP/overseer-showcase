import { PHONE_QUERY } from '../lib/phoneLayout';

/** `PHONE_QUERY` escaped as a regular-expression source, for finding its `@media` blocks in a stylesheet. */
export const PHONE_MEDIA = PHONE_QUERY.replace(/[()]/g, '\\$&');
