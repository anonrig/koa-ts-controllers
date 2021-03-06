import { IKoaControllerOptions } from '../index';
import { validate } from 'class-validator';
import { plainToClass } from 'class-transformer';
import _ from 'lodash';
import { Context } from 'koa';
import { isClass } from './tools';

const boom = require('@hapi/boom');

async function _argumentInjectorProcessor(name, body, injectOptions) {
    if (!injectOptions) {
        return body;
    }

    if (typeof injectOptions === 'string') {
        return body[injectOptions];
    } else if (typeof injectOptions === 'object') {
        // is required
        if (injectOptions.required && (!body || _.isEmpty(body))) {
            throw boom.badData('Body: is required and cannot be null');
        }

        return body;
    }

    throw boom.badImplementation(`${name}: Cannot handle injection options ${injectOptions}`);
}

const argumentInjectorMap = {
    // currentUser: async (ctx: any, injectOptions: any) => {
    //     return ctx.state.user;
    // },
    session: async (ctx: any, injectOptions: any) => {
        if (!ctx.session) throw boom.failedDependency('Sessions have not been activated on this server');

        if (typeof injectOptions === 'string') {
            return ctx.session[injectOptions];
        }
        return ctx.session;
    },
    ctx: async (ctx: any, injectOptions: any) => ctx,
    query: async (ctx: any, injectOptions: any) => {
        return _argumentInjectorProcessor('query', ctx.query, injectOptions);
    },
    body: async (ctx: any, injectOptions: any) => {
        return _argumentInjectorProcessor('body', ctx.request.body, injectOptions);
    }
};

async function _determineArgument(ctx: Context, index, { injectSource, injectOptions }, type) {
    let result;

    if (argumentInjectorMap[injectSource]) {
        result = await argumentInjectorMap[injectSource](ctx, injectOptions);
    } else {
        // not a special arg injector? Try to pull argument from ctx
        result = ctx[injectSource];
        if (result && injectOptions) {
            result = result[injectOptions];
        }
    }

    // validate if this is a class
    if (result && isClass(type)) {
        result = await plainToClass(type, result);
        const errors = await validate(result); // TODO: wrap around this to trap runtime errors
        if (errors.length > 0) {
            throw boom.badData('validation error for argument type: ' + injectSource,
                errors.map(it => {
                    return { field: it.property, violations: it.constraints };
                })
            );
        }
    } else if (type === Number) {
        result = Number(result);
    }

    return result;
}

async function _generateEndPoints(router, options: IKoaControllerOptions, controller, parentPath: string, generatingForVersion: string | number) {
    const actions = controller.actions;

    let deprecationMessage = '';
    if (
        options.versions &&
        typeof options.versions[generatingForVersion] === 'string'
    ) {
        deprecationMessage = options.versions[generatingForVersion];
    }

    const mappedActions = Object.keys(actions).map(action => actions[action]);

    for (const action of mappedActions) {
        let willAddEndpoint = true;

        // If API versioning mode is active...
        if (generatingForVersion) {
            // ...and endpoint has some version constraints defined...
            if (action.limitToVersions && !_.isEmpty(action.limitToVersions)) {
                const endpointLimit = action.limitToVersions[generatingForVersion];

                // ...and current endpoint version being generated does NOT exist in the constraint
                if (!endpointLimit) {
                    // then ignore this version of the endpoint
                    willAddEndpoint = false;
                }
                // but if current endpoint version being generated DOES exist in the constraint and it is a string...
                else if (typeof endpointLimit === 'string') {
                    // ...this is a deprecation message
                    deprecationMessage += ` ${endpointLimit}`;
                }
            }
        } else {
            // else If in-built api versioning mode is disabled...
            // ...and endpoint has some version constraints defined...
            if (action.limitToVersions && !_.isEmpty(action.limitToVersions)) {
                // , then ignore any endpoint handler with a @Version decorator. Default to catch-all-remainders
                willAddEndpoint = false;
            }
        }

        if (willAddEndpoint) {
            const path = '/' + (parentPath + action.path).split('/').filter(i => i.length).join('/');

            const flow = [
                ...(options.flow || []),
                ...(controller.flow || []),
                ...(action.flow || [])
            ];

            flow.push(async function (ctx) {
                const targetArguments = [];

                if (deprecationMessage) {
                    ctx.set({ deprecation: deprecationMessage });
                }

                // inject data into arguments
                if (action.arguments) {
                    for (const index of Object.keys(action.arguments)) {
                        const argumentMeta = action.arguments[index];

                        targetArguments[index] = await _determineArgument(ctx, index, argumentMeta, action.argumentTypes[index]);
                    }
                }

                // run target endpoint handler
                ctx.body = await action.target(...targetArguments);
            });

            router[action.verb](path, ...flow);
        }
    }
}

/**
 * Fill up router with routes
 * @param router
 * @param options
 * @param metadata
 */
export async function generateRoutes(router, options: IKoaControllerOptions, metadata) {

    const basePath = options.basePath || ''; // e.g /api
    const controllers: any[] = Object.values(metadata.controllers);

    for (const controller of controllers) {
        const paths = Array.isArray(controller.path)
            ? controller.path
            : [controller.path];

        if (options.disableVersioning) {
            // e.g /api/users

            for (const path of paths) {
                await _generateEndPoints(
                    router,
                    options,
                    controller,
                    basePath + path,
                    undefined
                );
            }
        } else {
            // e.g /api/v1/user

            const versions = _.isArray(options.versions) ? options.versions
                : _.keysIn(options.versions);
            for (const version of versions) {
                for (const path of paths) {
                    await _generateEndPoints(
                        router,
                        options,
                        controller,
                        basePath + `/v${version}` + path,
                        version
                    );
                }
            }
        }
    }
}
