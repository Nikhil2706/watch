/**
 * The id SpecialFeaturesRow puts on its section, so SpecialFeaturesJump has
 * somewhere to go. Its own module rather than an export of either component:
 * the row is a server component, and a plain value imported from a
 * "use client" file arrives there as a client reference, not a string.
 */
export const SPECIAL_FEATURES_ANCHOR = "special-features";
