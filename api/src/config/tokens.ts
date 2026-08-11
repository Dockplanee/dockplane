/**
 * Injection tokens.
 *
 * Kept free of imports and separate from the module that provides them: a
 * service that needs a token would otherwise pull in the module file, and the
 * resulting import cycle leaves constructor metadata undefined at runtime.
 */
export const LOGGER = Symbol('DOCKPLANE_LOGGER');
export const SECRET_BOX = Symbol('DOCKPLANE_SECRET_BOX');
