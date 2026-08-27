'use strict';

var GenericInitiativeProvider = require('./generic-initiative-provider').GenericInitiativeProvider;
var InitiativeProviderRegistry = require('./initiative-provider-registry').InitiativeProviderRegistry;
var TrustedFixtureInitiativeProvider = require('./trusted-fixture-initiative-provider').TrustedFixtureInitiativeProvider;
var WtcResourceProgramProvider = require('./wtc-resource-program-provider').WtcResourceProgramProvider;

function createDefaultInitiativeRegistry(options) {
    var providers = [new GenericInitiativeProvider(), new WtcResourceProgramProvider()];
    if (options && options.includeTrustedFixtureProvider === true) {
        providers.push(new TrustedFixtureInitiativeProvider());
    }
    return new InitiativeProviderRegistry(providers);
}

module.exports = {
    createDefaultInitiativeRegistry: createDefaultInitiativeRegistry
};
