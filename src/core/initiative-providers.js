'use strict';

var GenericInitiativeProvider = require('./generic-initiative-provider').GenericInitiativeProvider;
var EmbeddedInitiativeAppProvider = require('./embedded-initiative-app-provider').EmbeddedInitiativeAppProvider;
var InitiativeProviderRegistry = require('./initiative-provider-registry').InitiativeProviderRegistry;

function createDefaultInitiativeRegistry() {
    var providers = [new GenericInitiativeProvider(), new EmbeddedInitiativeAppProvider()];
    return new InitiativeProviderRegistry(providers);
}

module.exports = {
    createDefaultInitiativeRegistry: createDefaultInitiativeRegistry
};
