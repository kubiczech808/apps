export declare const accountKeychain: readonly [{
    readonly name: "authorizeKey";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "uint8";
        readonly name: "signatureType";
    }, {
        readonly type: "uint64";
        readonly name: "expiry";
    }, {
        readonly type: "bool";
        readonly name: "enforceLimits";
    }, {
        readonly type: "tuple[]";
        readonly name: "limits";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "uint256";
            readonly name: "amount";
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "authorizeKey";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "uint8";
        readonly name: "signatureType";
    }, {
        readonly type: "tuple";
        readonly name: "config";
        readonly components: readonly [{
            readonly type: "uint64";
            readonly name: "expiry";
        }, {
            readonly type: "bool";
            readonly name: "enforceLimits";
        }, {
            readonly type: "tuple[]";
            readonly name: "limits";
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "token";
            }, {
                readonly type: "uint256";
                readonly name: "amount";
            }, {
                readonly type: "uint64";
                readonly name: "period";
            }];
        }, {
            readonly type: "bool";
            readonly name: "allowAnyCalls";
        }, {
            readonly type: "tuple[]";
            readonly name: "allowedCalls";
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "target";
            }, {
                readonly type: "tuple[]";
                readonly name: "selectorRules";
                readonly components: readonly [{
                    readonly type: "bytes4";
                    readonly name: "selector";
                }, {
                    readonly type: "address[]";
                    readonly name: "recipients";
                }];
            }];
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "authorizeKey";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "uint8";
        readonly name: "signatureType";
    }, {
        readonly type: "tuple";
        readonly name: "config";
        readonly components: readonly [{
            readonly type: "uint64";
            readonly name: "expiry";
        }, {
            readonly type: "bool";
            readonly name: "enforceLimits";
        }, {
            readonly type: "tuple[]";
            readonly name: "limits";
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "token";
            }, {
                readonly type: "uint256";
                readonly name: "amount";
            }, {
                readonly type: "uint64";
                readonly name: "period";
            }];
        }, {
            readonly type: "bool";
            readonly name: "allowAnyCalls";
        }, {
            readonly type: "tuple[]";
            readonly name: "allowedCalls";
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "target";
            }, {
                readonly type: "tuple[]";
                readonly name: "selectorRules";
                readonly components: readonly [{
                    readonly type: "bytes4";
                    readonly name: "selector";
                }, {
                    readonly type: "address[]";
                    readonly name: "recipients";
                }];
            }];
        }];
    }, {
        readonly type: "bytes32";
        readonly name: "witness";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "authorizeAdminKey";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "uint8";
        readonly name: "signatureType";
    }, {
        readonly type: "bytes32";
        readonly name: "witness";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "burnKeyAuthorizationWitness";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "witness";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "revokeKey";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "updateSpendingLimit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "uint256";
        readonly name: "newLimit";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setAllowedCalls";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "tuple[]";
        readonly name: "scopes";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "target";
        }, {
            readonly type: "tuple[]";
            readonly name: "selectorRules";
            readonly components: readonly [{
                readonly type: "bytes4";
                readonly name: "selector";
            }, {
                readonly type: "address[]";
                readonly name: "recipients";
            }];
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "removeAllowedCalls";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "address";
        readonly name: "target";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "getKey";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "address";
        readonly name: "keyId";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "uint8";
            readonly name: "signatureType";
        }, {
            readonly type: "address";
            readonly name: "keyId";
        }, {
            readonly type: "uint64";
            readonly name: "expiry";
        }, {
            readonly type: "bool";
            readonly name: "enforceLimits";
        }, {
            readonly type: "bool";
            readonly name: "isRevoked";
        }];
    }];
}, {
    readonly name: "getRemainingLimit";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "remaining";
    }];
}, {
    readonly name: "getRemainingLimitWithPeriod";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "remaining";
    }, {
        readonly type: "uint64";
        readonly name: "periodEnd";
    }];
}, {
    readonly name: "getAllowedCalls";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "address";
        readonly name: "keyId";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
        readonly name: "isScoped";
    }, {
        readonly type: "tuple[]";
        readonly name: "scopes";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "target";
        }, {
            readonly type: "tuple[]";
            readonly name: "selectorRules";
            readonly components: readonly [{
                readonly type: "bytes4";
                readonly name: "selector";
            }, {
                readonly type: "address[]";
                readonly name: "recipients";
            }];
        }];
    }];
}, {
    readonly name: "isKeyAuthorizationWitnessBurned";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "bytes32";
        readonly name: "witness";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "isAdminKey";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "address";
        readonly name: "keyId";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "getTransactionKey";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "KeyAuthorized";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "publicKey";
        readonly indexed: true;
    }, {
        readonly type: "uint8";
        readonly name: "signatureType";
    }, {
        readonly type: "uint64";
        readonly name: "expiry";
    }];
}, {
    readonly name: "AdminKeyAuthorized";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "publicKey";
        readonly indexed: true;
    }];
}, {
    readonly name: "KeyRevoked";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "publicKey";
        readonly indexed: true;
    }];
}, {
    readonly name: "SpendingLimitUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "publicKey";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "newLimit";
    }];
}, {
    readonly name: "AccessKeySpend";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "publicKey";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "uint256";
        readonly name: "remainingLimit";
    }];
}, {
    readonly name: "KeyAuthorizationWitness";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "witness";
        readonly indexed: true;
    }];
}, {
    readonly name: "KeyAuthorizationWitnessBurned";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "witness";
        readonly indexed: true;
    }];
}, {
    readonly name: "UnauthorizedCaller";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "KeyAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "KeyNotFound";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "KeyExpired";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "SpendingLimitExceeded";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSpendingLimit";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignatureType";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ZeroPublicKey";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ExpiryInPast";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "KeyAlreadyRevoked";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "SignatureTypeMismatch";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "uint8";
        readonly name: "expected";
    }, {
        readonly type: "uint8";
        readonly name: "actual";
    }];
}, {
    readonly name: "CallNotAllowed";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidCallScope";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidKeyId";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidKeyAuthorizationWitness";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "KeyAuthorizationWitnessAlreadyBurned";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "LegacyAuthorizeKeySelectorChanged";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "bytes4";
        readonly name: "newSelector";
    }];
}];
export declare const addressRegistry: readonly [{
    readonly name: "registerVirtualMaster";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "salt";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes4";
        readonly name: "masterId";
    }];
}, {
    readonly name: "getMaster";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes4";
        readonly name: "masterId";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "resolveRecipient";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
        readonly name: "effectiveRecipient";
    }];
}, {
    readonly name: "resolveVirtualAddress";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "virtualAddr";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
        readonly name: "master";
    }];
}, {
    readonly name: "isVirtualAddress";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "addr";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "decodeVirtualAddress";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "addr";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
        readonly name: "isVirtual";
    }, {
        readonly type: "bytes4";
        readonly name: "masterId";
    }, {
        readonly type: "bytes6";
        readonly name: "userTag";
    }];
}, {
    readonly name: "isImplicitlyApproved";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "addr";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "MasterRegistered";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes4";
        readonly name: "masterId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "masterAddress";
        readonly indexed: true;
    }];
}, {
    readonly name: "MasterIdCollision";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "master";
    }];
}, {
    readonly name: "InvalidMasterAddress";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ProofOfWorkFailed";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "VirtualAddressUnregistered";
    readonly type: "error";
    readonly inputs: readonly [];
}];
export declare const nonce: readonly [{
    readonly name: "getNonce";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "uint256";
        readonly name: "nonceKey";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
        readonly name: "nonce";
    }];
}, {
    readonly name: "NonceIncremented";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "nonceKey";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "newNonce";
    }];
}, {
    readonly name: "ProtocolNonceNotSupported";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidNonceKey";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NonceOverflow";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ExpiringNonceReplay";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ExpiringNonceSetFull";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidExpiringNonceExpiry";
    readonly type: "error";
    readonly inputs: readonly [];
}];
export declare const receivePolicyGuard: readonly [{
    readonly name: "balanceOf";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes";
        readonly name: "receipt";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "claim";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "bytes";
        readonly name: "receipt";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "burnBlockedReceipt";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes";
        readonly name: "receipt";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "TransferBlocked";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "receiver";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "blockedNonce";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "uint8";
        readonly name: "receiptVersion";
    }, {
        readonly type: "bytes";
        readonly name: "receipt";
    }];
}, {
    readonly name: "ReceiptClaimed";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "receiver";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "blockedNonce";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "blockedAt";
    }, {
        readonly type: "uint8";
        readonly name: "receiptVersion";
    }, {
        readonly type: "address";
        readonly name: "originator";
    }, {
        readonly type: "address";
        readonly name: "recipient";
    }, {
        readonly type: "address";
        readonly name: "recoveryAuthority";
    }, {
        readonly type: "address";
        readonly name: "caller";
    }, {
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "ReceiptBurned";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "receiver";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "blockedNonce";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "blockedAt";
    }, {
        readonly type: "uint8";
        readonly name: "receiptVersion";
    }, {
        readonly type: "address";
        readonly name: "originator";
    }, {
        readonly type: "address";
        readonly name: "recipient";
    }, {
        readonly type: "address";
        readonly name: "recoveryAuthority";
    }, {
        readonly type: "address";
        readonly name: "caller";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "InvalidReceipt";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidClaimAddress";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "UnauthorizedClaimer";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "AddressReserved";
    readonly type: "error";
    readonly inputs: readonly [];
}];
export declare const signatureVerifier: readonly [{
    readonly name: "recover";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "hash";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
        readonly name: "signer";
    }];
}, {
    readonly name: "verify";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "signer";
    }, {
        readonly type: "bytes32";
        readonly name: "hash";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "verifyKeychain";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "bytes32";
        readonly name: "hash";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "verifyKeychainAdmin";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "bytes32";
        readonly name: "hash";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "InvalidFormat";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignature";
    readonly type: "error";
    readonly inputs: readonly [];
}];
export declare const stablecoinDex: readonly [{
    readonly name: "createPair";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "base";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
        readonly name: "key";
    }];
}, {
    readonly name: "place";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "uint128";
        readonly name: "amount";
    }, {
        readonly type: "bool";
        readonly name: "isBid";
    }, {
        readonly type: "int16";
        readonly name: "tick";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
    }];
}, {
    readonly name: "placeFlip";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "uint128";
        readonly name: "amount";
    }, {
        readonly type: "bool";
        readonly name: "isBid";
    }, {
        readonly type: "int16";
        readonly name: "tick";
    }, {
        readonly type: "int16";
        readonly name: "flipTick";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
    }];
}, {
    readonly name: "cancel";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "cancelStaleOrder";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "swapExactAmountIn";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "tokenIn";
    }, {
        readonly type: "address";
        readonly name: "tokenOut";
    }, {
        readonly type: "uint128";
        readonly name: "amountIn";
    }, {
        readonly type: "uint128";
        readonly name: "minAmountOut";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "amountOut";
    }];
}, {
    readonly name: "swapExactAmountOut";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "tokenIn";
    }, {
        readonly type: "address";
        readonly name: "tokenOut";
    }, {
        readonly type: "uint128";
        readonly name: "amountOut";
    }, {
        readonly type: "uint128";
        readonly name: "maxAmountIn";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "amountIn";
    }];
}, {
    readonly name: "quoteSwapExactAmountIn";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "tokenIn";
    }, {
        readonly type: "address";
        readonly name: "tokenOut";
    }, {
        readonly type: "uint128";
        readonly name: "amountIn";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "amountOut";
    }];
}, {
    readonly name: "quoteSwapExactAmountOut";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "tokenIn";
    }, {
        readonly type: "address";
        readonly name: "tokenOut";
    }, {
        readonly type: "uint128";
        readonly name: "amountOut";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "amountIn";
    }];
}, {
    readonly name: "balanceOf";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "user";
    }, {
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
    }];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "uint128";
        readonly name: "amount";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "getOrder";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "uint128";
            readonly name: "orderId";
        }, {
            readonly type: "address";
            readonly name: "maker";
        }, {
            readonly type: "bytes32";
            readonly name: "bookKey";
        }, {
            readonly type: "bool";
            readonly name: "isBid";
        }, {
            readonly type: "int16";
            readonly name: "tick";
        }, {
            readonly type: "uint128";
            readonly name: "amount";
        }, {
            readonly type: "uint128";
            readonly name: "remaining";
        }, {
            readonly type: "uint128";
            readonly name: "prev";
        }, {
            readonly type: "uint128";
            readonly name: "next";
        }, {
            readonly type: "bool";
            readonly name: "isFlip";
        }, {
            readonly type: "int16";
            readonly name: "flipTick";
        }];
    }];
}, {
    readonly name: "getTickLevel";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "base";
    }, {
        readonly type: "int16";
        readonly name: "tick";
    }, {
        readonly type: "bool";
        readonly name: "isBid";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "head";
    }, {
        readonly type: "uint128";
        readonly name: "tail";
    }, {
        readonly type: "uint128";
        readonly name: "totalLiquidity";
    }];
}, {
    readonly name: "pairKey";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "tokenA";
    }, {
        readonly type: "address";
        readonly name: "tokenB";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "nextOrderId";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint128";
    }];
}, {
    readonly name: "books";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "pairKey";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "base";
        }, {
            readonly type: "address";
            readonly name: "quote";
        }, {
            readonly type: "int16";
            readonly name: "bestBidTick";
        }, {
            readonly type: "int16";
            readonly name: "bestAskTick";
        }];
    }];
}, {
    readonly name: "MIN_TICK";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "int16";
    }];
}, {
    readonly name: "MAX_TICK";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "int16";
    }];
}, {
    readonly name: "TICK_SPACING";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "int16";
    }];
}, {
    readonly name: "PRICE_SCALE";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint32";
    }];
}, {
    readonly name: "MIN_ORDER_AMOUNT";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint128";
    }];
}, {
    readonly name: "MIN_PRICE";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint32";
    }];
}, {
    readonly name: "MAX_PRICE";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint32";
    }];
}, {
    readonly name: "tickToPrice";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "int16";
        readonly name: "tick";
    }];
    readonly outputs: readonly [{
        readonly type: "uint32";
        readonly name: "price";
    }];
}, {
    readonly name: "priceToTick";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "uint32";
        readonly name: "price";
    }];
    readonly outputs: readonly [{
        readonly type: "int16";
        readonly name: "tick";
    }];
}, {
    readonly name: "PairCreated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "key";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "base";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "quote";
        readonly indexed: true;
    }];
}, {
    readonly name: "OrderPlaced";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "maker";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "uint128";
        readonly name: "amount";
    }, {
        readonly type: "bool";
        readonly name: "isBid";
    }, {
        readonly type: "int16";
        readonly name: "tick";
    }, {
        readonly type: "bool";
        readonly name: "isFlipOrder";
    }, {
        readonly type: "int16";
        readonly name: "flipTick";
    }];
}, {
    readonly name: "OrderFilled";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "maker";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "taker";
        readonly indexed: true;
    }, {
        readonly type: "uint128";
        readonly name: "amountFilled";
    }, {
        readonly type: "bool";
        readonly name: "partialFill";
    }];
}, {
    readonly name: "OrderFlipped";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "maker";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "uint128";
        readonly name: "amount";
    }, {
        readonly type: "bool";
        readonly name: "isBid";
    }, {
        readonly type: "int16";
        readonly name: "tick";
    }, {
        readonly type: "int16";
        readonly name: "flipTick";
    }];
}, {
    readonly name: "FlipFailed";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "maker";
        readonly indexed: true;
    }, {
        readonly type: "bytes4";
        readonly name: "reason";
    }];
}, {
    readonly name: "OrderCancelled";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
        readonly indexed: true;
    }];
}, {
    readonly name: "Unauthorized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "PairDoesNotExist";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "PairAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "OrderDoesNotExist";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "IdenticalTokens";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "TickOutOfBounds";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "int16";
        readonly name: "tick";
    }];
}, {
    readonly name: "InvalidTick";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidFlipTick";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InsufficientBalance";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InsufficientLiquidity";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InsufficientOutput";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "MaxInputExceeded";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "BelowMinimumOrderSize";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "amount";
    }];
}, {
    readonly name: "InvalidBaseToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "OrderNotStale";
    readonly type: "error";
    readonly inputs: readonly [];
}];
export declare const tip20: readonly [{
    readonly name: "name";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "string";
    }];
}, {
    readonly name: "symbol";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "string";
    }];
}, {
    readonly name: "decimals";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint8";
    }];
}, {
    readonly name: "totalSupply";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "quoteToken";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "nextQuoteToken";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "balanceOf";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "transfer";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "approve";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "spender";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "allowance";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "address";
        readonly name: "spender";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "transferFrom";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
    }, {
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "mint";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "burn";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "currency";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "string";
    }];
}, {
    readonly name: "supplyCap";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "paused";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "transferPolicyId";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "logoURI";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "string";
    }];
}, {
    readonly name: "setLogoURI";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "newLogoURI";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "burnBlocked";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "mintWithMemo";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "bytes32";
        readonly name: "memo";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "burnWithMemo";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "bytes32";
        readonly name: "memo";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "transferWithMemo";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "bytes32";
        readonly name: "memo";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "transferFromWithMemo";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
    }, {
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "bytes32";
        readonly name: "memo";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "changeTransferPolicyId";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "newPolicyId";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setSupplyCap";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "newSupplyCap";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "pause";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
}, {
    readonly name: "unpause";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
}, {
    readonly name: "setNextQuoteToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "newQuoteToken";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "completeQuoteTokenUpdate";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
}, {
    readonly name: "PAUSE_ROLE";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "UNPAUSE_ROLE";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "ISSUER_ROLE";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "BURN_BLOCKED_ROLE";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "permit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "address";
        readonly name: "spender";
    }, {
        readonly type: "uint256";
        readonly name: "value";
    }, {
        readonly type: "uint256";
        readonly name: "deadline";
    }, {
        readonly type: "uint8";
        readonly name: "v";
    }, {
        readonly type: "bytes32";
        readonly name: "r";
    }, {
        readonly type: "bytes32";
        readonly name: "s";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "nonces";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "DOMAIN_SEPARATOR";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "distributeReward";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setRewardRecipient";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "recipient";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "claimRewards";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "optedInSupply";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint128";
    }];
}, {
    readonly name: "globalRewardPerToken";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "userRewardInfo";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "rewardRecipient";
        }, {
            readonly type: "uint256";
            readonly name: "rewardPerToken";
        }, {
            readonly type: "uint256";
            readonly name: "rewardBalance";
        }];
    }];
}, {
    readonly name: "getPendingRewards";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
    }];
}, {
    readonly name: "Transfer";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "to";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "Approval";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "spender";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "Mint";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "Burn";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "BurnBlocked";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "TransferWithMemo";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "to";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "bytes32";
        readonly name: "memo";
        readonly indexed: true;
    }];
}, {
    readonly name: "TransferPolicyUpdate";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "newPolicyId";
        readonly indexed: true;
    }];
}, {
    readonly name: "SupplyCapUpdate";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "newSupplyCap";
        readonly indexed: true;
    }];
}, {
    readonly name: "PauseStateUpdate";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "bool";
        readonly name: "isPaused";
    }];
}, {
    readonly name: "NextQuoteTokenSet";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "nextQuoteToken";
        readonly indexed: true;
    }];
}, {
    readonly name: "QuoteTokenUpdate";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "newQuoteToken";
        readonly indexed: true;
    }];
}, {
    readonly name: "RewardDistributed";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "funder";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "RewardRecipientSet";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "holder";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "recipient";
        readonly indexed: true;
    }];
}, {
    readonly name: "LogoURIUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "string";
        readonly name: "newLogoURI";
    }];
}, {
    readonly name: "InsufficientBalance";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "available";
    }, {
        readonly type: "uint256";
        readonly name: "required";
    }, {
        readonly type: "address";
        readonly name: "token";
    }];
}, {
    readonly name: "InsufficientAllowance";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "SupplyCapExceeded";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSupplyCap";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidPayload";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "PolicyForbids";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidRecipient";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ContractPaused";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidCurrency";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidQuoteToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidAmount";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NoOptedInSupply";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "Unauthorized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ProtectedAddress";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "Uninitialized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidTransferPolicyId";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "PermitExpired";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignature";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "LogoURITooLong";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidLogoURI";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "hasRole";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "bytes32";
        readonly name: "role";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "getRoleAdmin";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "grantRole";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
    }, {
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "revokeRole";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
    }, {
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "renounceRole";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setRoleAdmin";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
    }, {
        readonly type: "bytes32";
        readonly name: "adminRole";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "RoleMembershipUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "sender";
        readonly indexed: true;
    }, {
        readonly type: "bool";
        readonly name: "hasRole";
    }];
}, {
    readonly name: "RoleAdminUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "newAdminRole";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "sender";
        readonly indexed: true;
    }];
}, {
    readonly name: "Unauthorized";
    readonly type: "error";
    readonly inputs: readonly [];
}];
export declare const tip20ChannelReserve: readonly [{
    readonly name: "CLOSE_GRACE_PERIOD";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "VOUCHER_TYPEHASH";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "open";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "payee";
    }, {
        readonly type: "address";
        readonly name: "operator";
    }, {
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "uint96";
        readonly name: "deposit";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }, {
        readonly type: "address";
        readonly name: "authorizedSigner";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
    }];
}, {
    readonly name: "settle";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly name: "descriptor";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "payer";
        }, {
            readonly type: "address";
            readonly name: "payee";
        }, {
            readonly type: "address";
            readonly name: "operator";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }, {
            readonly type: "address";
            readonly name: "authorizedSigner";
        }, {
            readonly type: "bytes32";
            readonly name: "expiringNonceHash";
        }];
    }, {
        readonly type: "uint96";
        readonly name: "cumulativeAmount";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "topUp";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly name: "descriptor";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "payer";
        }, {
            readonly type: "address";
            readonly name: "payee";
        }, {
            readonly type: "address";
            readonly name: "operator";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }, {
            readonly type: "address";
            readonly name: "authorizedSigner";
        }, {
            readonly type: "bytes32";
            readonly name: "expiringNonceHash";
        }];
    }, {
        readonly type: "uint96";
        readonly name: "additionalDeposit";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "close";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly name: "descriptor";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "payer";
        }, {
            readonly type: "address";
            readonly name: "payee";
        }, {
            readonly type: "address";
            readonly name: "operator";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }, {
            readonly type: "address";
            readonly name: "authorizedSigner";
        }, {
            readonly type: "bytes32";
            readonly name: "expiringNonceHash";
        }];
    }, {
        readonly type: "uint96";
        readonly name: "cumulativeAmount";
    }, {
        readonly type: "uint96";
        readonly name: "captureAmount";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "requestClose";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly name: "descriptor";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "payer";
        }, {
            readonly type: "address";
            readonly name: "payee";
        }, {
            readonly type: "address";
            readonly name: "operator";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }, {
            readonly type: "address";
            readonly name: "authorizedSigner";
        }, {
            readonly type: "bytes32";
            readonly name: "expiringNonceHash";
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly name: "descriptor";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "payer";
        }, {
            readonly type: "address";
            readonly name: "payee";
        }, {
            readonly type: "address";
            readonly name: "operator";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }, {
            readonly type: "address";
            readonly name: "authorizedSigner";
        }, {
            readonly type: "bytes32";
            readonly name: "expiringNonceHash";
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "getChannel";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly name: "descriptor";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "payer";
        }, {
            readonly type: "address";
            readonly name: "payee";
        }, {
            readonly type: "address";
            readonly name: "operator";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }, {
            readonly type: "address";
            readonly name: "authorizedSigner";
        }, {
            readonly type: "bytes32";
            readonly name: "expiringNonceHash";
        }];
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "tuple";
            readonly name: "descriptor";
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "payer";
            }, {
                readonly type: "address";
                readonly name: "payee";
            }, {
                readonly type: "address";
                readonly name: "operator";
            }, {
                readonly type: "address";
                readonly name: "token";
            }, {
                readonly type: "bytes32";
                readonly name: "salt";
            }, {
                readonly type: "address";
                readonly name: "authorizedSigner";
            }, {
                readonly type: "bytes32";
                readonly name: "expiringNonceHash";
            }];
        }, {
            readonly type: "tuple";
            readonly name: "state";
            readonly components: readonly [{
                readonly type: "uint96";
                readonly name: "settled";
            }, {
                readonly type: "uint96";
                readonly name: "deposit";
            }, {
                readonly type: "uint32";
                readonly name: "closeRequestedAt";
            }];
        }];
    }];
}, {
    readonly name: "getChannelState";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "uint96";
            readonly name: "settled";
        }, {
            readonly type: "uint96";
            readonly name: "deposit";
        }, {
            readonly type: "uint32";
            readonly name: "closeRequestedAt";
        }];
    }];
}, {
    readonly name: "getChannelStatesBatch";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32[]";
        readonly name: "channelIds";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple[]";
        readonly components: readonly [{
            readonly type: "uint96";
            readonly name: "settled";
        }, {
            readonly type: "uint96";
            readonly name: "deposit";
        }, {
            readonly type: "uint32";
            readonly name: "closeRequestedAt";
        }];
    }];
}, {
    readonly name: "computeChannelId";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "payer";
    }, {
        readonly type: "address";
        readonly name: "payee";
    }, {
        readonly type: "address";
        readonly name: "operator";
    }, {
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }, {
        readonly type: "address";
        readonly name: "authorizedSigner";
    }, {
        readonly type: "bytes32";
        readonly name: "expiringNonceHash";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "getVoucherDigest";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
    }, {
        readonly type: "uint96";
        readonly name: "cumulativeAmount";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "domainSeparator";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "ChannelOpened";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payer";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payee";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "operator";
    }, {
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "address";
        readonly name: "authorizedSigner";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }, {
        readonly type: "bytes32";
        readonly name: "expiringNonceHash";
    }, {
        readonly type: "uint96";
        readonly name: "deposit";
    }];
}, {
    readonly name: "Settled";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payer";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payee";
        readonly indexed: true;
    }, {
        readonly type: "uint96";
        readonly name: "cumulativeAmount";
    }, {
        readonly type: "uint96";
        readonly name: "deltaPaid";
    }, {
        readonly type: "uint96";
        readonly name: "newSettled";
    }];
}, {
    readonly name: "TopUp";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payer";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payee";
        readonly indexed: true;
    }, {
        readonly type: "uint96";
        readonly name: "additionalDeposit";
    }, {
        readonly type: "uint96";
        readonly name: "newDeposit";
    }];
}, {
    readonly name: "CloseRequested";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payer";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payee";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "closeGraceEnd";
    }];
}, {
    readonly name: "ChannelClosed";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payer";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payee";
        readonly indexed: true;
    }, {
        readonly type: "uint96";
        readonly name: "settledToPayee";
    }, {
        readonly type: "uint96";
        readonly name: "refundedToPayer";
    }];
}, {
    readonly name: "CloseRequestCancelled";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payer";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payee";
        readonly indexed: true;
    }];
}, {
    readonly name: "ChannelAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ChannelNotFound";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NotPayer";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NotPayeeOrOperator";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidPayee";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ZeroDeposit";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ExpiringNonceHashNotSet";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignature";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "AmountExceedsDeposit";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "AmountNotIncreasing";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "CaptureAmountInvalid";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "CloseNotReady";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "DepositOverflow";
    readonly type: "error";
    readonly inputs: readonly [];
}];
export declare const tip20Factory: readonly [{
    readonly name: "createToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "name";
    }, {
        readonly type: "string";
        readonly name: "symbol";
    }, {
        readonly type: "string";
        readonly name: "currency";
    }, {
        readonly type: "address";
        readonly name: "quoteToken";
    }, {
        readonly type: "address";
        readonly name: "admin";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "createToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "name";
    }, {
        readonly type: "string";
        readonly name: "symbol";
    }, {
        readonly type: "string";
        readonly name: "currency";
    }, {
        readonly type: "address";
        readonly name: "quoteToken";
    }, {
        readonly type: "address";
        readonly name: "admin";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }, {
        readonly type: "string";
        readonly name: "logoURI";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "isTIP20";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "getTokenAddress";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "sender";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "TokenCreated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "string";
        readonly name: "name";
    }, {
        readonly type: "string";
        readonly name: "symbol";
    }, {
        readonly type: "string";
        readonly name: "currency";
    }, {
        readonly type: "address";
        readonly name: "quoteToken";
    }, {
        readonly type: "address";
        readonly name: "admin";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }];
}, {
    readonly name: "AddressReserved";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "AddressNotReserved";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidQuoteToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "TokenAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }];
}];
export declare const tip403Registry: readonly [{
    readonly name: "policyIdCounter";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "policyExists";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "policyData";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }];
    readonly outputs: readonly [{
        readonly type: "uint8";
        readonly name: "policyType";
    }, {
        readonly type: "address";
        readonly name: "admin";
    }];
}, {
    readonly name: "isAuthorized";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "user";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "isAuthorizedSender";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "user";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "isAuthorizedRecipient";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "user";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "isAuthorizedMintRecipient";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "user";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "compoundPolicyData";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
        readonly name: "senderPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "recipientPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "mintRecipientPolicyId";
    }];
}, {
    readonly name: "receivePolicy";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
        readonly name: "hasReceivePolicy";
    }, {
        readonly type: "uint64";
        readonly name: "senderPolicyId";
    }, {
        readonly type: "uint8";
        readonly name: "senderPolicyType";
    }, {
        readonly type: "uint64";
        readonly name: "tokenFilterId";
    }, {
        readonly type: "uint8";
        readonly name: "tokenFilterType";
    }, {
        readonly type: "address";
        readonly name: "recoveryAuthority";
    }];
}, {
    readonly name: "validateReceivePolicy";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "address";
        readonly name: "sender";
    }, {
        readonly type: "address";
        readonly name: "receiver";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
        readonly name: "authorized";
    }, {
        readonly type: "uint8";
        readonly name: "blockedReason";
    }];
}, {
    readonly name: "createPolicy";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "admin";
    }, {
        readonly type: "uint8";
        readonly name: "policyType";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "createPolicyWithAccounts";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "admin";
    }, {
        readonly type: "uint8";
        readonly name: "policyType";
    }, {
        readonly type: "address[]";
        readonly name: "accounts";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "setPolicyAdmin";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "admin";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "modifyPolicyWhitelist";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "bool";
        readonly name: "allowed";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "modifyPolicyBlacklist";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "bool";
        readonly name: "restricted";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "createCompoundPolicy";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "senderPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "recipientPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "mintRecipientPolicyId";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "setReceivePolicy";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "senderPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "tokenFilterId";
    }, {
        readonly type: "address";
        readonly name: "recoveryAuthority";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "PolicyAdminUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "admin";
        readonly indexed: true;
    }];
}, {
    readonly name: "PolicyCreated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "uint8";
        readonly name: "policyType";
    }];
}, {
    readonly name: "WhitelistUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "bool";
        readonly name: "allowed";
    }];
}, {
    readonly name: "BlacklistUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "bool";
        readonly name: "restricted";
    }];
}, {
    readonly name: "CompoundPolicyCreated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "creator";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "senderPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "recipientPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "mintRecipientPolicyId";
    }];
}, {
    readonly name: "ReceivePolicyUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "senderPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "tokenFilterId";
    }, {
        readonly type: "address";
        readonly name: "recoveryAuthority";
    }];
}, {
    readonly name: "Unauthorized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "PolicyNotFound";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "PolicyNotSimple";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidPolicyType";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "IncompatiblePolicyType";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "VirtualAddressNotAllowed";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidReceivePolicyType";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidRecoveryAuthority";
    readonly type: "error";
    readonly inputs: readonly [];
}];
export declare const feeManager: readonly [{
    readonly name: "userTokens";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "user";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "validatorTokens";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "setUserToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setValidatorToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "distributeFees";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
    }, {
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "collectedFees";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
    }, {
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "UserTokenSet";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "user";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }];
}, {
    readonly name: "ValidatorTokenSet";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }];
}, {
    readonly name: "FeesDistributed";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "InvalidToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InsufficientFeeTokenBalance";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "CannotChangeWithinBlock";
    readonly type: "error";
    readonly inputs: readonly [];
}];
export declare const feeAmm: readonly [{
    readonly name: "M";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "N";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "SCALE";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "MIN_LIQUIDITY";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "getPoolId";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "userToken";
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "getPool";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "userToken";
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "uint128";
            readonly name: "reserveUserToken";
        }, {
            readonly type: "uint128";
            readonly name: "reserveValidatorToken";
        }];
    }];
}, {
    readonly name: "pools";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "poolId";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "uint128";
            readonly name: "reserveUserToken";
        }, {
            readonly type: "uint128";
            readonly name: "reserveValidatorToken";
        }];
    }];
}, {
    readonly name: "mint";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "userToken";
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
    }, {
        readonly type: "uint256";
        readonly name: "amountValidatorToken";
    }, {
        readonly type: "address";
        readonly name: "to";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "liquidity";
    }];
}, {
    readonly name: "burn";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "userToken";
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
    }, {
        readonly type: "uint256";
        readonly name: "liquidity";
    }, {
        readonly type: "address";
        readonly name: "to";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "amountUserToken";
    }, {
        readonly type: "uint256";
        readonly name: "amountValidatorToken";
    }];
}, {
    readonly name: "totalSupply";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "poolId";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "liquidityBalances";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "poolId";
    }, {
        readonly type: "address";
        readonly name: "user";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "rebalanceSwap";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "userToken";
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
    }, {
        readonly type: "uint256";
        readonly name: "amountOut";
    }, {
        readonly type: "address";
        readonly name: "to";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "amountIn";
    }];
}, {
    readonly name: "Mint";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "sender";
    }, {
        readonly type: "address";
        readonly name: "to";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "userToken";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amountValidatorToken";
    }, {
        readonly type: "uint256";
        readonly name: "liquidity";
    }];
}, {
    readonly name: "Burn";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "sender";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "userToken";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amountUserToken";
    }, {
        readonly type: "uint256";
        readonly name: "amountValidatorToken";
    }, {
        readonly type: "uint256";
        readonly name: "liquidity";
    }, {
        readonly type: "address";
        readonly name: "to";
    }];
}, {
    readonly name: "RebalanceSwap";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "userToken";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "swapper";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amountIn";
    }, {
        readonly type: "uint256";
        readonly name: "amountOut";
    }];
}, {
    readonly name: "IdenticalAddresses";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InsufficientLiquidity";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InsufficientReserves";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidAmount";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "DivisionByZero";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSwapCalculation";
    readonly type: "error";
    readonly inputs: readonly [];
}];
export declare const validatorConfig: readonly [{
    readonly name: "getValidators";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "tuple[]";
        readonly name: "validators";
        readonly components: readonly [{
            readonly type: "bytes32";
            readonly name: "publicKey";
        }, {
            readonly type: "bool";
            readonly name: "active";
        }, {
            readonly type: "uint64";
            readonly name: "index";
        }, {
            readonly type: "address";
            readonly name: "validatorAddress";
        }, {
            readonly type: "string";
            readonly name: "inboundAddress";
        }, {
            readonly type: "string";
            readonly name: "outboundAddress";
        }];
    }];
}, {
    readonly name: "addValidator";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "newValidatorAddress";
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }, {
        readonly type: "bool";
        readonly name: "active";
    }, {
        readonly type: "string";
        readonly name: "inboundAddress";
    }, {
        readonly type: "string";
        readonly name: "outboundAddress";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "updateValidator";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "newValidatorAddress";
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }, {
        readonly type: "string";
        readonly name: "inboundAddress";
    }, {
        readonly type: "string";
        readonly name: "outboundAddress";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "changeValidatorStatus";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
    }, {
        readonly type: "bool";
        readonly name: "active";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "changeValidatorStatusByIndex";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
    }, {
        readonly type: "bool";
        readonly name: "active";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "owner";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "changeOwner";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "newOwner";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "getNextFullDkgCeremony";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "setNextFullDkgCeremony";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "epoch";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "validatorsArray";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "index";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "validators";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "bytes32";
            readonly name: "publicKey";
        }, {
            readonly type: "bool";
            readonly name: "active";
        }, {
            readonly type: "uint64";
            readonly name: "index";
        }, {
            readonly type: "address";
            readonly name: "validatorAddress";
        }, {
            readonly type: "string";
            readonly name: "inboundAddress";
        }, {
            readonly type: "string";
            readonly name: "outboundAddress";
        }];
    }];
}, {
    readonly name: "validatorCount";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "Unauthorized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ValidatorAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ValidatorNotFound";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidPublicKey";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NotHostPort";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "field";
    }, {
        readonly type: "string";
        readonly name: "input";
    }, {
        readonly type: "string";
        readonly name: "backtrace";
    }];
}, {
    readonly name: "NotIpPort";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "field";
    }, {
        readonly type: "string";
        readonly name: "input";
    }, {
        readonly type: "string";
        readonly name: "backtrace";
    }];
}];
export declare const storageCredits: readonly [{
    readonly type: "error";
    readonly name: "DelegateCallNotAllowed";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidMode";
    readonly inputs: readonly [];
}, {
    readonly type: "function";
    readonly name: "balanceOf";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly type: "function";
    readonly name: "modeOf";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly type: "uint8";
    }];
}, {
    readonly type: "function";
    readonly name: "budgetOf";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly type: "function";
    readonly name: "setMode";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "newMode";
        readonly type: "uint8";
    }];
    readonly outputs: readonly [];
}, {
    readonly type: "function";
    readonly name: "setBudget";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "creditBudget";
        readonly type: "uint64";
    }];
    readonly outputs: readonly [];
}];
export declare const validatorConfigV2: readonly [{
    readonly name: "getActiveValidators";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "tuple[]";
        readonly name: "validators";
        readonly components: readonly [{
            readonly type: "bytes32";
            readonly name: "publicKey";
        }, {
            readonly type: "address";
            readonly name: "validatorAddress";
        }, {
            readonly type: "string";
            readonly name: "ingress";
        }, {
            readonly type: "string";
            readonly name: "egress";
        }, {
            readonly type: "address";
            readonly name: "feeRecipient";
        }, {
            readonly type: "uint64";
            readonly name: "index";
        }, {
            readonly type: "uint64";
            readonly name: "addedAtHeight";
        }, {
            readonly type: "uint64";
            readonly name: "deactivatedAtHeight";
        }];
    }];
}, {
    readonly name: "getInitializedAtHeight";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "owner";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "validatorCount";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "validatorByIndex";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "bytes32";
            readonly name: "publicKey";
        }, {
            readonly type: "address";
            readonly name: "validatorAddress";
        }, {
            readonly type: "string";
            readonly name: "ingress";
        }, {
            readonly type: "string";
            readonly name: "egress";
        }, {
            readonly type: "address";
            readonly name: "feeRecipient";
        }, {
            readonly type: "uint64";
            readonly name: "index";
        }, {
            readonly type: "uint64";
            readonly name: "addedAtHeight";
        }, {
            readonly type: "uint64";
            readonly name: "deactivatedAtHeight";
        }];
    }];
}, {
    readonly name: "validatorByAddress";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validatorAddress";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "bytes32";
            readonly name: "publicKey";
        }, {
            readonly type: "address";
            readonly name: "validatorAddress";
        }, {
            readonly type: "string";
            readonly name: "ingress";
        }, {
            readonly type: "string";
            readonly name: "egress";
        }, {
            readonly type: "address";
            readonly name: "feeRecipient";
        }, {
            readonly type: "uint64";
            readonly name: "index";
        }, {
            readonly type: "uint64";
            readonly name: "addedAtHeight";
        }, {
            readonly type: "uint64";
            readonly name: "deactivatedAtHeight";
        }];
    }];
}, {
    readonly name: "validatorByPublicKey";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "publicKey";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "bytes32";
            readonly name: "publicKey";
        }, {
            readonly type: "address";
            readonly name: "validatorAddress";
        }, {
            readonly type: "string";
            readonly name: "ingress";
        }, {
            readonly type: "string";
            readonly name: "egress";
        }, {
            readonly type: "address";
            readonly name: "feeRecipient";
        }, {
            readonly type: "uint64";
            readonly name: "index";
        }, {
            readonly type: "uint64";
            readonly name: "addedAtHeight";
        }, {
            readonly type: "uint64";
            readonly name: "deactivatedAtHeight";
        }];
    }];
}, {
    readonly name: "getNextNetworkIdentityRotationEpoch";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "isInitialized";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "addValidator";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validatorAddress";
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }, {
        readonly type: "string";
        readonly name: "ingress";
    }, {
        readonly type: "string";
        readonly name: "egress";
    }, {
        readonly type: "address";
        readonly name: "feeRecipient";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
    }];
}, {
    readonly name: "deactivateValidator";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "idx";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "rotateValidator";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "idx";
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }, {
        readonly type: "string";
        readonly name: "ingress";
    }, {
        readonly type: "string";
        readonly name: "egress";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setFeeRecipient";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "idx";
    }, {
        readonly type: "address";
        readonly name: "feeRecipient";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setIpAddresses";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "idx";
    }, {
        readonly type: "string";
        readonly name: "ingress";
    }, {
        readonly type: "string";
        readonly name: "egress";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "transferValidatorOwnership";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "idx";
    }, {
        readonly type: "address";
        readonly name: "newAddress";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "transferOwnership";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "newOwner";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setNetworkIdentityRotationEpoch";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "epoch";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "migrateValidator";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "idx";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "initializeIfMigrated";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
}, {
    readonly name: "ValidatorAdded";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorAddress";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }, {
        readonly type: "string";
        readonly name: "ingress";
    }, {
        readonly type: "string";
        readonly name: "egress";
    }, {
        readonly type: "address";
        readonly name: "feeRecipient";
    }];
}, {
    readonly name: "ValidatorDeactivated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorAddress";
        readonly indexed: true;
    }];
}, {
    readonly name: "ValidatorRotated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "deactivatedIndex";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorAddress";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "oldPublicKey";
    }, {
        readonly type: "bytes32";
        readonly name: "newPublicKey";
    }, {
        readonly type: "string";
        readonly name: "ingress";
    }, {
        readonly type: "string";
        readonly name: "egress";
    }, {
        readonly type: "address";
        readonly name: "caller";
    }];
}, {
    readonly name: "FeeRecipientUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "feeRecipient";
    }, {
        readonly type: "address";
        readonly name: "caller";
    }];
}, {
    readonly name: "IpAddressesUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "string";
        readonly name: "ingress";
    }, {
        readonly type: "string";
        readonly name: "egress";
    }, {
        readonly type: "address";
        readonly name: "caller";
    }];
}, {
    readonly name: "ValidatorOwnershipTransferred";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "oldAddress";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "newAddress";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "caller";
    }];
}, {
    readonly name: "OwnershipTransferred";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "oldOwner";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "newOwner";
        readonly indexed: true;
    }];
}, {
    readonly name: "ValidatorMigrated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorAddress";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }];
}, {
    readonly name: "NetworkIdentityRotationEpochSet";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "previousEpoch";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "nextEpoch";
        readonly indexed: true;
    }];
}, {
    readonly name: "Initialized";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "height";
    }];
}, {
    readonly name: "SkippedValidatorMigration";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorAddress";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }];
}, {
    readonly name: "AlreadyInitialized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "IngressAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "ingress";
    }];
}, {
    readonly name: "EmptyV1ValidatorSet";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidMigrationIndex";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidOwner";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidPublicKey";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignature";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignatureFormat";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidValidatorAddress";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "MigrationNotComplete";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NotInitialized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NotIp";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "input";
    }, {
        readonly type: "string";
        readonly name: "backtrace";
    }];
}, {
    readonly name: "NotIpPort";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "input";
    }, {
        readonly type: "string";
        readonly name: "backtrace";
    }];
}, {
    readonly name: "PublicKeyAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "Unauthorized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "AddressAlreadyHasValidator";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ValidatorAlreadyDeactivated";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ValidatorNotFound";
    readonly type: "error";
    readonly inputs: readonly [];
}];
export declare const abis: readonly [{
    readonly name: "authorizeKey";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "uint8";
        readonly name: "signatureType";
    }, {
        readonly type: "uint64";
        readonly name: "expiry";
    }, {
        readonly type: "bool";
        readonly name: "enforceLimits";
    }, {
        readonly type: "tuple[]";
        readonly name: "limits";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "uint256";
            readonly name: "amount";
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "authorizeKey";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "uint8";
        readonly name: "signatureType";
    }, {
        readonly type: "tuple";
        readonly name: "config";
        readonly components: readonly [{
            readonly type: "uint64";
            readonly name: "expiry";
        }, {
            readonly type: "bool";
            readonly name: "enforceLimits";
        }, {
            readonly type: "tuple[]";
            readonly name: "limits";
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "token";
            }, {
                readonly type: "uint256";
                readonly name: "amount";
            }, {
                readonly type: "uint64";
                readonly name: "period";
            }];
        }, {
            readonly type: "bool";
            readonly name: "allowAnyCalls";
        }, {
            readonly type: "tuple[]";
            readonly name: "allowedCalls";
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "target";
            }, {
                readonly type: "tuple[]";
                readonly name: "selectorRules";
                readonly components: readonly [{
                    readonly type: "bytes4";
                    readonly name: "selector";
                }, {
                    readonly type: "address[]";
                    readonly name: "recipients";
                }];
            }];
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "authorizeKey";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "uint8";
        readonly name: "signatureType";
    }, {
        readonly type: "tuple";
        readonly name: "config";
        readonly components: readonly [{
            readonly type: "uint64";
            readonly name: "expiry";
        }, {
            readonly type: "bool";
            readonly name: "enforceLimits";
        }, {
            readonly type: "tuple[]";
            readonly name: "limits";
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "token";
            }, {
                readonly type: "uint256";
                readonly name: "amount";
            }, {
                readonly type: "uint64";
                readonly name: "period";
            }];
        }, {
            readonly type: "bool";
            readonly name: "allowAnyCalls";
        }, {
            readonly type: "tuple[]";
            readonly name: "allowedCalls";
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "target";
            }, {
                readonly type: "tuple[]";
                readonly name: "selectorRules";
                readonly components: readonly [{
                    readonly type: "bytes4";
                    readonly name: "selector";
                }, {
                    readonly type: "address[]";
                    readonly name: "recipients";
                }];
            }];
        }];
    }, {
        readonly type: "bytes32";
        readonly name: "witness";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "authorizeAdminKey";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "uint8";
        readonly name: "signatureType";
    }, {
        readonly type: "bytes32";
        readonly name: "witness";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "burnKeyAuthorizationWitness";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "witness";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "revokeKey";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "updateSpendingLimit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "uint256";
        readonly name: "newLimit";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setAllowedCalls";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "tuple[]";
        readonly name: "scopes";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "target";
        }, {
            readonly type: "tuple[]";
            readonly name: "selectorRules";
            readonly components: readonly [{
                readonly type: "bytes4";
                readonly name: "selector";
            }, {
                readonly type: "address[]";
                readonly name: "recipients";
            }];
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "removeAllowedCalls";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "address";
        readonly name: "target";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "getKey";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "address";
        readonly name: "keyId";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "uint8";
            readonly name: "signatureType";
        }, {
            readonly type: "address";
            readonly name: "keyId";
        }, {
            readonly type: "uint64";
            readonly name: "expiry";
        }, {
            readonly type: "bool";
            readonly name: "enforceLimits";
        }, {
            readonly type: "bool";
            readonly name: "isRevoked";
        }];
    }];
}, {
    readonly name: "getRemainingLimit";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "remaining";
    }];
}, {
    readonly name: "getRemainingLimitWithPeriod";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "address";
        readonly name: "keyId";
    }, {
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "remaining";
    }, {
        readonly type: "uint64";
        readonly name: "periodEnd";
    }];
}, {
    readonly name: "getAllowedCalls";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "address";
        readonly name: "keyId";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
        readonly name: "isScoped";
    }, {
        readonly type: "tuple[]";
        readonly name: "scopes";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "target";
        }, {
            readonly type: "tuple[]";
            readonly name: "selectorRules";
            readonly components: readonly [{
                readonly type: "bytes4";
                readonly name: "selector";
            }, {
                readonly type: "address[]";
                readonly name: "recipients";
            }];
        }];
    }];
}, {
    readonly name: "isKeyAuthorizationWitnessBurned";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "bytes32";
        readonly name: "witness";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "isAdminKey";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "address";
        readonly name: "keyId";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "getTransactionKey";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "KeyAuthorized";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "publicKey";
        readonly indexed: true;
    }, {
        readonly type: "uint8";
        readonly name: "signatureType";
    }, {
        readonly type: "uint64";
        readonly name: "expiry";
    }];
}, {
    readonly name: "AdminKeyAuthorized";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "publicKey";
        readonly indexed: true;
    }];
}, {
    readonly name: "KeyRevoked";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "publicKey";
        readonly indexed: true;
    }];
}, {
    readonly name: "SpendingLimitUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "publicKey";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "newLimit";
    }];
}, {
    readonly name: "AccessKeySpend";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "publicKey";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "uint256";
        readonly name: "remainingLimit";
    }];
}, {
    readonly name: "KeyAuthorizationWitness";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "witness";
        readonly indexed: true;
    }];
}, {
    readonly name: "KeyAuthorizationWitnessBurned";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "witness";
        readonly indexed: true;
    }];
}, {
    readonly name: "UnauthorizedCaller";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "KeyAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "KeyNotFound";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "KeyExpired";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "SpendingLimitExceeded";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSpendingLimit";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignatureType";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ZeroPublicKey";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ExpiryInPast";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "KeyAlreadyRevoked";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "SignatureTypeMismatch";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "uint8";
        readonly name: "expected";
    }, {
        readonly type: "uint8";
        readonly name: "actual";
    }];
}, {
    readonly name: "CallNotAllowed";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidCallScope";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidKeyId";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidKeyAuthorizationWitness";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "KeyAuthorizationWitnessAlreadyBurned";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "LegacyAuthorizeKeySelectorChanged";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "bytes4";
        readonly name: "newSelector";
    }];
}, {
    readonly name: "registerVirtualMaster";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "salt";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes4";
        readonly name: "masterId";
    }];
}, {
    readonly name: "getMaster";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes4";
        readonly name: "masterId";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "resolveRecipient";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
        readonly name: "effectiveRecipient";
    }];
}, {
    readonly name: "resolveVirtualAddress";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "virtualAddr";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
        readonly name: "master";
    }];
}, {
    readonly name: "isVirtualAddress";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "addr";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "decodeVirtualAddress";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "addr";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
        readonly name: "isVirtual";
    }, {
        readonly type: "bytes4";
        readonly name: "masterId";
    }, {
        readonly type: "bytes6";
        readonly name: "userTag";
    }];
}, {
    readonly name: "isImplicitlyApproved";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "addr";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "MasterRegistered";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes4";
        readonly name: "masterId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "masterAddress";
        readonly indexed: true;
    }];
}, {
    readonly name: "MasterIdCollision";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "master";
    }];
}, {
    readonly name: "InvalidMasterAddress";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ProofOfWorkFailed";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "VirtualAddressUnregistered";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "getNonce";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "uint256";
        readonly name: "nonceKey";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
        readonly name: "nonce";
    }];
}, {
    readonly name: "NonceIncremented";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "nonceKey";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "newNonce";
    }];
}, {
    readonly name: "ProtocolNonceNotSupported";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidNonceKey";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NonceOverflow";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ExpiringNonceReplay";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ExpiringNonceSetFull";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidExpiringNonceExpiry";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "balanceOf";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes";
        readonly name: "receipt";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "claim";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "bytes";
        readonly name: "receipt";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "burnBlockedReceipt";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes";
        readonly name: "receipt";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "TransferBlocked";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "receiver";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "blockedNonce";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "uint8";
        readonly name: "receiptVersion";
    }, {
        readonly type: "bytes";
        readonly name: "receipt";
    }];
}, {
    readonly name: "ReceiptClaimed";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "receiver";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "blockedNonce";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "blockedAt";
    }, {
        readonly type: "uint8";
        readonly name: "receiptVersion";
    }, {
        readonly type: "address";
        readonly name: "originator";
    }, {
        readonly type: "address";
        readonly name: "recipient";
    }, {
        readonly type: "address";
        readonly name: "recoveryAuthority";
    }, {
        readonly type: "address";
        readonly name: "caller";
    }, {
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "ReceiptBurned";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "receiver";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "blockedNonce";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "blockedAt";
    }, {
        readonly type: "uint8";
        readonly name: "receiptVersion";
    }, {
        readonly type: "address";
        readonly name: "originator";
    }, {
        readonly type: "address";
        readonly name: "recipient";
    }, {
        readonly type: "address";
        readonly name: "recoveryAuthority";
    }, {
        readonly type: "address";
        readonly name: "caller";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "InvalidReceipt";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidClaimAddress";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "UnauthorizedClaimer";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "AddressReserved";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "recover";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "hash";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
        readonly name: "signer";
    }];
}, {
    readonly name: "verify";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "signer";
    }, {
        readonly type: "bytes32";
        readonly name: "hash";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "verifyKeychain";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "bytes32";
        readonly name: "hash";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "verifyKeychainAdmin";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "bytes32";
        readonly name: "hash";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "InvalidFormat";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignature";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "createPair";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "base";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
        readonly name: "key";
    }];
}, {
    readonly name: "place";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "uint128";
        readonly name: "amount";
    }, {
        readonly type: "bool";
        readonly name: "isBid";
    }, {
        readonly type: "int16";
        readonly name: "tick";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
    }];
}, {
    readonly name: "placeFlip";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "uint128";
        readonly name: "amount";
    }, {
        readonly type: "bool";
        readonly name: "isBid";
    }, {
        readonly type: "int16";
        readonly name: "tick";
    }, {
        readonly type: "int16";
        readonly name: "flipTick";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
    }];
}, {
    readonly name: "cancel";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "cancelStaleOrder";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "swapExactAmountIn";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "tokenIn";
    }, {
        readonly type: "address";
        readonly name: "tokenOut";
    }, {
        readonly type: "uint128";
        readonly name: "amountIn";
    }, {
        readonly type: "uint128";
        readonly name: "minAmountOut";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "amountOut";
    }];
}, {
    readonly name: "swapExactAmountOut";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "tokenIn";
    }, {
        readonly type: "address";
        readonly name: "tokenOut";
    }, {
        readonly type: "uint128";
        readonly name: "amountOut";
    }, {
        readonly type: "uint128";
        readonly name: "maxAmountIn";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "amountIn";
    }];
}, {
    readonly name: "quoteSwapExactAmountIn";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "tokenIn";
    }, {
        readonly type: "address";
        readonly name: "tokenOut";
    }, {
        readonly type: "uint128";
        readonly name: "amountIn";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "amountOut";
    }];
}, {
    readonly name: "quoteSwapExactAmountOut";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "tokenIn";
    }, {
        readonly type: "address";
        readonly name: "tokenOut";
    }, {
        readonly type: "uint128";
        readonly name: "amountOut";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "amountIn";
    }];
}, {
    readonly name: "balanceOf";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "user";
    }, {
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
    }];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "uint128";
        readonly name: "amount";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "getOrder";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "uint128";
            readonly name: "orderId";
        }, {
            readonly type: "address";
            readonly name: "maker";
        }, {
            readonly type: "bytes32";
            readonly name: "bookKey";
        }, {
            readonly type: "bool";
            readonly name: "isBid";
        }, {
            readonly type: "int16";
            readonly name: "tick";
        }, {
            readonly type: "uint128";
            readonly name: "amount";
        }, {
            readonly type: "uint128";
            readonly name: "remaining";
        }, {
            readonly type: "uint128";
            readonly name: "prev";
        }, {
            readonly type: "uint128";
            readonly name: "next";
        }, {
            readonly type: "bool";
            readonly name: "isFlip";
        }, {
            readonly type: "int16";
            readonly name: "flipTick";
        }];
    }];
}, {
    readonly name: "getTickLevel";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "base";
    }, {
        readonly type: "int16";
        readonly name: "tick";
    }, {
        readonly type: "bool";
        readonly name: "isBid";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
        readonly name: "head";
    }, {
        readonly type: "uint128";
        readonly name: "tail";
    }, {
        readonly type: "uint128";
        readonly name: "totalLiquidity";
    }];
}, {
    readonly name: "pairKey";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "tokenA";
    }, {
        readonly type: "address";
        readonly name: "tokenB";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "nextOrderId";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint128";
    }];
}, {
    readonly name: "books";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "pairKey";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "base";
        }, {
            readonly type: "address";
            readonly name: "quote";
        }, {
            readonly type: "int16";
            readonly name: "bestBidTick";
        }, {
            readonly type: "int16";
            readonly name: "bestAskTick";
        }];
    }];
}, {
    readonly name: "MIN_TICK";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "int16";
    }];
}, {
    readonly name: "MAX_TICK";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "int16";
    }];
}, {
    readonly name: "TICK_SPACING";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "int16";
    }];
}, {
    readonly name: "PRICE_SCALE";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint32";
    }];
}, {
    readonly name: "MIN_ORDER_AMOUNT";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint128";
    }];
}, {
    readonly name: "MIN_PRICE";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint32";
    }];
}, {
    readonly name: "MAX_PRICE";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint32";
    }];
}, {
    readonly name: "tickToPrice";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "int16";
        readonly name: "tick";
    }];
    readonly outputs: readonly [{
        readonly type: "uint32";
        readonly name: "price";
    }];
}, {
    readonly name: "priceToTick";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "uint32";
        readonly name: "price";
    }];
    readonly outputs: readonly [{
        readonly type: "int16";
        readonly name: "tick";
    }];
}, {
    readonly name: "PairCreated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "key";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "base";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "quote";
        readonly indexed: true;
    }];
}, {
    readonly name: "OrderPlaced";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "maker";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "uint128";
        readonly name: "amount";
    }, {
        readonly type: "bool";
        readonly name: "isBid";
    }, {
        readonly type: "int16";
        readonly name: "tick";
    }, {
        readonly type: "bool";
        readonly name: "isFlipOrder";
    }, {
        readonly type: "int16";
        readonly name: "flipTick";
    }];
}, {
    readonly name: "OrderFilled";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "maker";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "taker";
        readonly indexed: true;
    }, {
        readonly type: "uint128";
        readonly name: "amountFilled";
    }, {
        readonly type: "bool";
        readonly name: "partialFill";
    }];
}, {
    readonly name: "OrderFlipped";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "maker";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "uint128";
        readonly name: "amount";
    }, {
        readonly type: "bool";
        readonly name: "isBid";
    }, {
        readonly type: "int16";
        readonly name: "tick";
    }, {
        readonly type: "int16";
        readonly name: "flipTick";
    }];
}, {
    readonly name: "FlipFailed";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "maker";
        readonly indexed: true;
    }, {
        readonly type: "bytes4";
        readonly name: "reason";
    }];
}, {
    readonly name: "OrderCancelled";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "orderId";
        readonly indexed: true;
    }];
}, {
    readonly name: "Unauthorized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "PairDoesNotExist";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "PairAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "OrderDoesNotExist";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "IdenticalTokens";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "TickOutOfBounds";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "int16";
        readonly name: "tick";
    }];
}, {
    readonly name: "InvalidTick";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidFlipTick";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InsufficientBalance";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InsufficientLiquidity";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InsufficientOutput";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "MaxInputExceeded";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "BelowMinimumOrderSize";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "uint128";
        readonly name: "amount";
    }];
}, {
    readonly name: "InvalidBaseToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "OrderNotStale";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "DelegateCallNotAllowed";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidMode";
    readonly inputs: readonly [];
}, {
    readonly type: "function";
    readonly name: "balanceOf";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly type: "function";
    readonly name: "modeOf";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly type: "uint8";
    }];
}, {
    readonly type: "function";
    readonly name: "budgetOf";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly type: "function";
    readonly name: "setMode";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "newMode";
        readonly type: "uint8";
    }];
    readonly outputs: readonly [];
}, {
    readonly type: "function";
    readonly name: "setBudget";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "creditBudget";
        readonly type: "uint64";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "name";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "string";
    }];
}, {
    readonly name: "symbol";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "string";
    }];
}, {
    readonly name: "decimals";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint8";
    }];
}, {
    readonly name: "totalSupply";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "quoteToken";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "nextQuoteToken";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "balanceOf";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "transfer";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "approve";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "spender";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "allowance";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "address";
        readonly name: "spender";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "transferFrom";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
    }, {
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "mint";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "burn";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "currency";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "string";
    }];
}, {
    readonly name: "supplyCap";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "paused";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "transferPolicyId";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "logoURI";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "string";
    }];
}, {
    readonly name: "setLogoURI";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "newLogoURI";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "burnBlocked";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "mintWithMemo";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "bytes32";
        readonly name: "memo";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "burnWithMemo";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "bytes32";
        readonly name: "memo";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "transferWithMemo";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "bytes32";
        readonly name: "memo";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "transferFromWithMemo";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
    }, {
        readonly type: "address";
        readonly name: "to";
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "bytes32";
        readonly name: "memo";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "changeTransferPolicyId";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "newPolicyId";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setSupplyCap";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "newSupplyCap";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "pause";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
}, {
    readonly name: "unpause";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
}, {
    readonly name: "setNextQuoteToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "newQuoteToken";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "completeQuoteTokenUpdate";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
}, {
    readonly name: "PAUSE_ROLE";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "UNPAUSE_ROLE";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "ISSUER_ROLE";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "BURN_BLOCKED_ROLE";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "permit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "address";
        readonly name: "spender";
    }, {
        readonly type: "uint256";
        readonly name: "value";
    }, {
        readonly type: "uint256";
        readonly name: "deadline";
    }, {
        readonly type: "uint8";
        readonly name: "v";
    }, {
        readonly type: "bytes32";
        readonly name: "r";
    }, {
        readonly type: "bytes32";
        readonly name: "s";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "nonces";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "DOMAIN_SEPARATOR";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "distributeReward";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "amount";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setRewardRecipient";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "recipient";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "claimRewards";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "optedInSupply";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint128";
    }];
}, {
    readonly name: "globalRewardPerToken";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "userRewardInfo";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "rewardRecipient";
        }, {
            readonly type: "uint256";
            readonly name: "rewardPerToken";
        }, {
            readonly type: "uint256";
            readonly name: "rewardBalance";
        }];
    }];
}, {
    readonly name: "getPendingRewards";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [{
        readonly type: "uint128";
    }];
}, {
    readonly name: "Transfer";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "to";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "Approval";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "spender";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "Mint";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "to";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "Burn";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "BurnBlocked";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "TransferWithMemo";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "from";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "to";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }, {
        readonly type: "bytes32";
        readonly name: "memo";
        readonly indexed: true;
    }];
}, {
    readonly name: "TransferPolicyUpdate";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "newPolicyId";
        readonly indexed: true;
    }];
}, {
    readonly name: "SupplyCapUpdate";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "newSupplyCap";
        readonly indexed: true;
    }];
}, {
    readonly name: "PauseStateUpdate";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "bool";
        readonly name: "isPaused";
    }];
}, {
    readonly name: "NextQuoteTokenSet";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "nextQuoteToken";
        readonly indexed: true;
    }];
}, {
    readonly name: "QuoteTokenUpdate";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "newQuoteToken";
        readonly indexed: true;
    }];
}, {
    readonly name: "RewardDistributed";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "funder";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "RewardRecipientSet";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "holder";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "recipient";
        readonly indexed: true;
    }];
}, {
    readonly name: "LogoURIUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "string";
        readonly name: "newLogoURI";
    }];
}, {
    readonly name: "InsufficientBalance";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "available";
    }, {
        readonly type: "uint256";
        readonly name: "required";
    }, {
        readonly type: "address";
        readonly name: "token";
    }];
}, {
    readonly name: "InsufficientAllowance";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "SupplyCapExceeded";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSupplyCap";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidPayload";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "PolicyForbids";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidRecipient";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ContractPaused";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidCurrency";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidQuoteToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidAmount";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NoOptedInSupply";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "Unauthorized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ProtectedAddress";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "Uninitialized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidTransferPolicyId";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "PermitExpired";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignature";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "LogoURITooLong";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidLogoURI";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "hasRole";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "bytes32";
        readonly name: "role";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "getRoleAdmin";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "grantRole";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
    }, {
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "revokeRole";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
    }, {
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "renounceRole";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setRoleAdmin";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
    }, {
        readonly type: "bytes32";
        readonly name: "adminRole";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "RoleMembershipUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "sender";
        readonly indexed: true;
    }, {
        readonly type: "bool";
        readonly name: "hasRole";
    }];
}, {
    readonly name: "RoleAdminUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "role";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "newAdminRole";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "sender";
        readonly indexed: true;
    }];
}, {
    readonly name: "Unauthorized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "CLOSE_GRACE_PERIOD";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "VOUCHER_TYPEHASH";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "open";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "payee";
    }, {
        readonly type: "address";
        readonly name: "operator";
    }, {
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "uint96";
        readonly name: "deposit";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }, {
        readonly type: "address";
        readonly name: "authorizedSigner";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
    }];
}, {
    readonly name: "settle";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly name: "descriptor";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "payer";
        }, {
            readonly type: "address";
            readonly name: "payee";
        }, {
            readonly type: "address";
            readonly name: "operator";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }, {
            readonly type: "address";
            readonly name: "authorizedSigner";
        }, {
            readonly type: "bytes32";
            readonly name: "expiringNonceHash";
        }];
    }, {
        readonly type: "uint96";
        readonly name: "cumulativeAmount";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "topUp";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly name: "descriptor";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "payer";
        }, {
            readonly type: "address";
            readonly name: "payee";
        }, {
            readonly type: "address";
            readonly name: "operator";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }, {
            readonly type: "address";
            readonly name: "authorizedSigner";
        }, {
            readonly type: "bytes32";
            readonly name: "expiringNonceHash";
        }];
    }, {
        readonly type: "uint96";
        readonly name: "additionalDeposit";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "close";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly name: "descriptor";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "payer";
        }, {
            readonly type: "address";
            readonly name: "payee";
        }, {
            readonly type: "address";
            readonly name: "operator";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }, {
            readonly type: "address";
            readonly name: "authorizedSigner";
        }, {
            readonly type: "bytes32";
            readonly name: "expiringNonceHash";
        }];
    }, {
        readonly type: "uint96";
        readonly name: "cumulativeAmount";
    }, {
        readonly type: "uint96";
        readonly name: "captureAmount";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "requestClose";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly name: "descriptor";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "payer";
        }, {
            readonly type: "address";
            readonly name: "payee";
        }, {
            readonly type: "address";
            readonly name: "operator";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }, {
            readonly type: "address";
            readonly name: "authorizedSigner";
        }, {
            readonly type: "bytes32";
            readonly name: "expiringNonceHash";
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly name: "descriptor";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "payer";
        }, {
            readonly type: "address";
            readonly name: "payee";
        }, {
            readonly type: "address";
            readonly name: "operator";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }, {
            readonly type: "address";
            readonly name: "authorizedSigner";
        }, {
            readonly type: "bytes32";
            readonly name: "expiringNonceHash";
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "getChannel";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "tuple";
        readonly name: "descriptor";
        readonly components: readonly [{
            readonly type: "address";
            readonly name: "payer";
        }, {
            readonly type: "address";
            readonly name: "payee";
        }, {
            readonly type: "address";
            readonly name: "operator";
        }, {
            readonly type: "address";
            readonly name: "token";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }, {
            readonly type: "address";
            readonly name: "authorizedSigner";
        }, {
            readonly type: "bytes32";
            readonly name: "expiringNonceHash";
        }];
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "tuple";
            readonly name: "descriptor";
            readonly components: readonly [{
                readonly type: "address";
                readonly name: "payer";
            }, {
                readonly type: "address";
                readonly name: "payee";
            }, {
                readonly type: "address";
                readonly name: "operator";
            }, {
                readonly type: "address";
                readonly name: "token";
            }, {
                readonly type: "bytes32";
                readonly name: "salt";
            }, {
                readonly type: "address";
                readonly name: "authorizedSigner";
            }, {
                readonly type: "bytes32";
                readonly name: "expiringNonceHash";
            }];
        }, {
            readonly type: "tuple";
            readonly name: "state";
            readonly components: readonly [{
                readonly type: "uint96";
                readonly name: "settled";
            }, {
                readonly type: "uint96";
                readonly name: "deposit";
            }, {
                readonly type: "uint32";
                readonly name: "closeRequestedAt";
            }];
        }];
    }];
}, {
    readonly name: "getChannelState";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "uint96";
            readonly name: "settled";
        }, {
            readonly type: "uint96";
            readonly name: "deposit";
        }, {
            readonly type: "uint32";
            readonly name: "closeRequestedAt";
        }];
    }];
}, {
    readonly name: "getChannelStatesBatch";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32[]";
        readonly name: "channelIds";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple[]";
        readonly components: readonly [{
            readonly type: "uint96";
            readonly name: "settled";
        }, {
            readonly type: "uint96";
            readonly name: "deposit";
        }, {
            readonly type: "uint32";
            readonly name: "closeRequestedAt";
        }];
    }];
}, {
    readonly name: "computeChannelId";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "payer";
    }, {
        readonly type: "address";
        readonly name: "payee";
    }, {
        readonly type: "address";
        readonly name: "operator";
    }, {
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }, {
        readonly type: "address";
        readonly name: "authorizedSigner";
    }, {
        readonly type: "bytes32";
        readonly name: "expiringNonceHash";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "getVoucherDigest";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
    }, {
        readonly type: "uint96";
        readonly name: "cumulativeAmount";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "domainSeparator";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "ChannelOpened";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payer";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payee";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "operator";
    }, {
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "address";
        readonly name: "authorizedSigner";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }, {
        readonly type: "bytes32";
        readonly name: "expiringNonceHash";
    }, {
        readonly type: "uint96";
        readonly name: "deposit";
    }];
}, {
    readonly name: "Settled";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payer";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payee";
        readonly indexed: true;
    }, {
        readonly type: "uint96";
        readonly name: "cumulativeAmount";
    }, {
        readonly type: "uint96";
        readonly name: "deltaPaid";
    }, {
        readonly type: "uint96";
        readonly name: "newSettled";
    }];
}, {
    readonly name: "TopUp";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payer";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payee";
        readonly indexed: true;
    }, {
        readonly type: "uint96";
        readonly name: "additionalDeposit";
    }, {
        readonly type: "uint96";
        readonly name: "newDeposit";
    }];
}, {
    readonly name: "CloseRequested";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payer";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payee";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "closeGraceEnd";
    }];
}, {
    readonly name: "ChannelClosed";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payer";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payee";
        readonly indexed: true;
    }, {
        readonly type: "uint96";
        readonly name: "settledToPayee";
    }, {
        readonly type: "uint96";
        readonly name: "refundedToPayer";
    }];
}, {
    readonly name: "CloseRequestCancelled";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "channelId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payer";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "payee";
        readonly indexed: true;
    }];
}, {
    readonly name: "ChannelAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ChannelNotFound";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NotPayer";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NotPayeeOrOperator";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidPayee";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ZeroDeposit";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ExpiringNonceHashNotSet";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignature";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "AmountExceedsDeposit";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "AmountNotIncreasing";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "CaptureAmountInvalid";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "CloseNotReady";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "DepositOverflow";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "createToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "name";
    }, {
        readonly type: "string";
        readonly name: "symbol";
    }, {
        readonly type: "string";
        readonly name: "currency";
    }, {
        readonly type: "address";
        readonly name: "quoteToken";
    }, {
        readonly type: "address";
        readonly name: "admin";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "createToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "name";
    }, {
        readonly type: "string";
        readonly name: "symbol";
    }, {
        readonly type: "string";
        readonly name: "currency";
    }, {
        readonly type: "address";
        readonly name: "quoteToken";
    }, {
        readonly type: "address";
        readonly name: "admin";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }, {
        readonly type: "string";
        readonly name: "logoURI";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "isTIP20";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "getTokenAddress";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "sender";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "TokenCreated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "string";
        readonly name: "name";
    }, {
        readonly type: "string";
        readonly name: "symbol";
    }, {
        readonly type: "string";
        readonly name: "currency";
    }, {
        readonly type: "address";
        readonly name: "quoteToken";
    }, {
        readonly type: "address";
        readonly name: "admin";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }];
}, {
    readonly name: "AddressReserved";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "AddressNotReserved";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidQuoteToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "TokenAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }];
}, {
    readonly name: "policyIdCounter";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "policyExists";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "policyData";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }];
    readonly outputs: readonly [{
        readonly type: "uint8";
        readonly name: "policyType";
    }, {
        readonly type: "address";
        readonly name: "admin";
    }];
}, {
    readonly name: "isAuthorized";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "user";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "isAuthorizedSender";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "user";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "isAuthorizedRecipient";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "user";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "isAuthorizedMintRecipient";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "user";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "compoundPolicyData";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
        readonly name: "senderPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "recipientPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "mintRecipientPolicyId";
    }];
}, {
    readonly name: "receivePolicy";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
        readonly name: "hasReceivePolicy";
    }, {
        readonly type: "uint64";
        readonly name: "senderPolicyId";
    }, {
        readonly type: "uint8";
        readonly name: "senderPolicyType";
    }, {
        readonly type: "uint64";
        readonly name: "tokenFilterId";
    }, {
        readonly type: "uint8";
        readonly name: "tokenFilterType";
    }, {
        readonly type: "address";
        readonly name: "recoveryAuthority";
    }];
}, {
    readonly name: "validateReceivePolicy";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }, {
        readonly type: "address";
        readonly name: "sender";
    }, {
        readonly type: "address";
        readonly name: "receiver";
    }];
    readonly outputs: readonly [{
        readonly type: "bool";
        readonly name: "authorized";
    }, {
        readonly type: "uint8";
        readonly name: "blockedReason";
    }];
}, {
    readonly name: "createPolicy";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "admin";
    }, {
        readonly type: "uint8";
        readonly name: "policyType";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "createPolicyWithAccounts";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "admin";
    }, {
        readonly type: "uint8";
        readonly name: "policyType";
    }, {
        readonly type: "address[]";
        readonly name: "accounts";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "setPolicyAdmin";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "admin";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "modifyPolicyWhitelist";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "bool";
        readonly name: "allowed";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "modifyPolicyBlacklist";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
    }, {
        readonly type: "address";
        readonly name: "account";
    }, {
        readonly type: "bool";
        readonly name: "restricted";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "createCompoundPolicy";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "senderPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "recipientPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "mintRecipientPolicyId";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "setReceivePolicy";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "senderPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "tokenFilterId";
    }, {
        readonly type: "address";
        readonly name: "recoveryAuthority";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "PolicyAdminUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "admin";
        readonly indexed: true;
    }];
}, {
    readonly name: "PolicyCreated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "uint8";
        readonly name: "policyType";
    }];
}, {
    readonly name: "WhitelistUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "bool";
        readonly name: "allowed";
    }];
}, {
    readonly name: "BlacklistUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "updater";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "bool";
        readonly name: "restricted";
    }];
}, {
    readonly name: "CompoundPolicyCreated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "policyId";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "creator";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "senderPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "recipientPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "mintRecipientPolicyId";
    }];
}, {
    readonly name: "ReceivePolicyUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "account";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "senderPolicyId";
    }, {
        readonly type: "uint64";
        readonly name: "tokenFilterId";
    }, {
        readonly type: "address";
        readonly name: "recoveryAuthority";
    }];
}, {
    readonly name: "Unauthorized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "PolicyNotFound";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "PolicyNotSimple";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidPolicyType";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "IncompatiblePolicyType";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "VirtualAddressNotAllowed";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidReceivePolicyType";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidRecoveryAuthority";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "userTokens";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "user";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "validatorTokens";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "setUserToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setValidatorToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "distributeFees";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
    }, {
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "collectedFees";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
    }, {
        readonly type: "address";
        readonly name: "token";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "UserTokenSet";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "user";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }];
}, {
    readonly name: "ValidatorTokenSet";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }];
}, {
    readonly name: "FeesDistributed";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "token";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amount";
    }];
}, {
    readonly name: "InvalidToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InsufficientFeeTokenBalance";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "CannotChangeWithinBlock";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "M";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "N";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "SCALE";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "MIN_LIQUIDITY";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "getPoolId";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "userToken";
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes32";
    }];
}, {
    readonly name: "getPool";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "userToken";
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "uint128";
            readonly name: "reserveUserToken";
        }, {
            readonly type: "uint128";
            readonly name: "reserveValidatorToken";
        }];
    }];
}, {
    readonly name: "pools";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "poolId";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "uint128";
            readonly name: "reserveUserToken";
        }, {
            readonly type: "uint128";
            readonly name: "reserveValidatorToken";
        }];
    }];
}, {
    readonly name: "mint";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "userToken";
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
    }, {
        readonly type: "uint256";
        readonly name: "amountValidatorToken";
    }, {
        readonly type: "address";
        readonly name: "to";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "liquidity";
    }];
}, {
    readonly name: "burn";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "userToken";
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
    }, {
        readonly type: "uint256";
        readonly name: "liquidity";
    }, {
        readonly type: "address";
        readonly name: "to";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "amountUserToken";
    }, {
        readonly type: "uint256";
        readonly name: "amountValidatorToken";
    }];
}, {
    readonly name: "totalSupply";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "poolId";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "liquidityBalances";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "poolId";
    }, {
        readonly type: "address";
        readonly name: "user";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "rebalanceSwap";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "userToken";
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
    }, {
        readonly type: "uint256";
        readonly name: "amountOut";
    }, {
        readonly type: "address";
        readonly name: "to";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
        readonly name: "amountIn";
    }];
}, {
    readonly name: "Mint";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "sender";
    }, {
        readonly type: "address";
        readonly name: "to";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "userToken";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amountValidatorToken";
    }, {
        readonly type: "uint256";
        readonly name: "liquidity";
    }];
}, {
    readonly name: "Burn";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "sender";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "userToken";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amountUserToken";
    }, {
        readonly type: "uint256";
        readonly name: "amountValidatorToken";
    }, {
        readonly type: "uint256";
        readonly name: "liquidity";
    }, {
        readonly type: "address";
        readonly name: "to";
    }];
}, {
    readonly name: "RebalanceSwap";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "userToken";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorToken";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "swapper";
        readonly indexed: true;
    }, {
        readonly type: "uint256";
        readonly name: "amountIn";
    }, {
        readonly type: "uint256";
        readonly name: "amountOut";
    }];
}, {
    readonly name: "IdenticalAddresses";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidToken";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InsufficientLiquidity";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InsufficientReserves";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidAmount";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "DivisionByZero";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSwapCalculation";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "getValidators";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "tuple[]";
        readonly name: "validators";
        readonly components: readonly [{
            readonly type: "bytes32";
            readonly name: "publicKey";
        }, {
            readonly type: "bool";
            readonly name: "active";
        }, {
            readonly type: "uint64";
            readonly name: "index";
        }, {
            readonly type: "address";
            readonly name: "validatorAddress";
        }, {
            readonly type: "string";
            readonly name: "inboundAddress";
        }, {
            readonly type: "string";
            readonly name: "outboundAddress";
        }];
    }];
}, {
    readonly name: "addValidator";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "newValidatorAddress";
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }, {
        readonly type: "bool";
        readonly name: "active";
    }, {
        readonly type: "string";
        readonly name: "inboundAddress";
    }, {
        readonly type: "string";
        readonly name: "outboundAddress";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "updateValidator";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "newValidatorAddress";
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }, {
        readonly type: "string";
        readonly name: "inboundAddress";
    }, {
        readonly type: "string";
        readonly name: "outboundAddress";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "changeValidatorStatus";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
    }, {
        readonly type: "bool";
        readonly name: "active";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "changeValidatorStatusByIndex";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
    }, {
        readonly type: "bool";
        readonly name: "active";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "owner";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "changeOwner";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "newOwner";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "getNextFullDkgCeremony";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "setNextFullDkgCeremony";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "epoch";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "validatorsArray";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint256";
        readonly name: "index";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "validators";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validator";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "bytes32";
            readonly name: "publicKey";
        }, {
            readonly type: "bool";
            readonly name: "active";
        }, {
            readonly type: "uint64";
            readonly name: "index";
        }, {
            readonly type: "address";
            readonly name: "validatorAddress";
        }, {
            readonly type: "string";
            readonly name: "inboundAddress";
        }, {
            readonly type: "string";
            readonly name: "outboundAddress";
        }];
    }];
}, {
    readonly name: "validatorCount";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "Unauthorized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ValidatorAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ValidatorNotFound";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidPublicKey";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NotHostPort";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "field";
    }, {
        readonly type: "string";
        readonly name: "input";
    }, {
        readonly type: "string";
        readonly name: "backtrace";
    }];
}, {
    readonly name: "NotIpPort";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "field";
    }, {
        readonly type: "string";
        readonly name: "input";
    }, {
        readonly type: "string";
        readonly name: "backtrace";
    }];
}, {
    readonly name: "getActiveValidators";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "tuple[]";
        readonly name: "validators";
        readonly components: readonly [{
            readonly type: "bytes32";
            readonly name: "publicKey";
        }, {
            readonly type: "address";
            readonly name: "validatorAddress";
        }, {
            readonly type: "string";
            readonly name: "ingress";
        }, {
            readonly type: "string";
            readonly name: "egress";
        }, {
            readonly type: "address";
            readonly name: "feeRecipient";
        }, {
            readonly type: "uint64";
            readonly name: "index";
        }, {
            readonly type: "uint64";
            readonly name: "addedAtHeight";
        }, {
            readonly type: "uint64";
            readonly name: "deactivatedAtHeight";
        }];
    }];
}, {
    readonly name: "getInitializedAtHeight";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "owner";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "validatorCount";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "validatorByIndex";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "bytes32";
            readonly name: "publicKey";
        }, {
            readonly type: "address";
            readonly name: "validatorAddress";
        }, {
            readonly type: "string";
            readonly name: "ingress";
        }, {
            readonly type: "string";
            readonly name: "egress";
        }, {
            readonly type: "address";
            readonly name: "feeRecipient";
        }, {
            readonly type: "uint64";
            readonly name: "index";
        }, {
            readonly type: "uint64";
            readonly name: "addedAtHeight";
        }, {
            readonly type: "uint64";
            readonly name: "deactivatedAtHeight";
        }];
    }];
}, {
    readonly name: "validatorByAddress";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validatorAddress";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "bytes32";
            readonly name: "publicKey";
        }, {
            readonly type: "address";
            readonly name: "validatorAddress";
        }, {
            readonly type: "string";
            readonly name: "ingress";
        }, {
            readonly type: "string";
            readonly name: "egress";
        }, {
            readonly type: "address";
            readonly name: "feeRecipient";
        }, {
            readonly type: "uint64";
            readonly name: "index";
        }, {
            readonly type: "uint64";
            readonly name: "addedAtHeight";
        }, {
            readonly type: "uint64";
            readonly name: "deactivatedAtHeight";
        }];
    }];
}, {
    readonly name: "validatorByPublicKey";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "bytes32";
        readonly name: "publicKey";
    }];
    readonly outputs: readonly [{
        readonly type: "tuple";
        readonly components: readonly [{
            readonly type: "bytes32";
            readonly name: "publicKey";
        }, {
            readonly type: "address";
            readonly name: "validatorAddress";
        }, {
            readonly type: "string";
            readonly name: "ingress";
        }, {
            readonly type: "string";
            readonly name: "egress";
        }, {
            readonly type: "address";
            readonly name: "feeRecipient";
        }, {
            readonly type: "uint64";
            readonly name: "index";
        }, {
            readonly type: "uint64";
            readonly name: "addedAtHeight";
        }, {
            readonly type: "uint64";
            readonly name: "deactivatedAtHeight";
        }];
    }];
}, {
    readonly name: "getNextNetworkIdentityRotationEpoch";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint64";
    }];
}, {
    readonly name: "isInitialized";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "bool";
    }];
}, {
    readonly name: "addValidator";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "validatorAddress";
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }, {
        readonly type: "string";
        readonly name: "ingress";
    }, {
        readonly type: "string";
        readonly name: "egress";
    }, {
        readonly type: "address";
        readonly name: "feeRecipient";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
    }];
}, {
    readonly name: "deactivateValidator";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "idx";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "rotateValidator";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "idx";
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }, {
        readonly type: "string";
        readonly name: "ingress";
    }, {
        readonly type: "string";
        readonly name: "egress";
    }, {
        readonly type: "bytes";
        readonly name: "signature";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setFeeRecipient";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "idx";
    }, {
        readonly type: "address";
        readonly name: "feeRecipient";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setIpAddresses";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "idx";
    }, {
        readonly type: "string";
        readonly name: "ingress";
    }, {
        readonly type: "string";
        readonly name: "egress";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "transferValidatorOwnership";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "idx";
    }, {
        readonly type: "address";
        readonly name: "newAddress";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "transferOwnership";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "newOwner";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setNetworkIdentityRotationEpoch";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "epoch";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "migrateValidator";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "idx";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "initializeIfMigrated";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
}, {
    readonly name: "ValidatorAdded";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorAddress";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }, {
        readonly type: "string";
        readonly name: "ingress";
    }, {
        readonly type: "string";
        readonly name: "egress";
    }, {
        readonly type: "address";
        readonly name: "feeRecipient";
    }];
}, {
    readonly name: "ValidatorDeactivated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorAddress";
        readonly indexed: true;
    }];
}, {
    readonly name: "ValidatorRotated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "deactivatedIndex";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorAddress";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "oldPublicKey";
    }, {
        readonly type: "bytes32";
        readonly name: "newPublicKey";
    }, {
        readonly type: "string";
        readonly name: "ingress";
    }, {
        readonly type: "string";
        readonly name: "egress";
    }, {
        readonly type: "address";
        readonly name: "caller";
    }];
}, {
    readonly name: "FeeRecipientUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "feeRecipient";
    }, {
        readonly type: "address";
        readonly name: "caller";
    }];
}, {
    readonly name: "IpAddressesUpdated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "string";
        readonly name: "ingress";
    }, {
        readonly type: "string";
        readonly name: "egress";
    }, {
        readonly type: "address";
        readonly name: "caller";
    }];
}, {
    readonly name: "ValidatorOwnershipTransferred";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "oldAddress";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "newAddress";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "caller";
    }];
}, {
    readonly name: "OwnershipTransferred";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "oldOwner";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "newOwner";
        readonly indexed: true;
    }];
}, {
    readonly name: "ValidatorMigrated";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorAddress";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }];
}, {
    readonly name: "NetworkIdentityRotationEpochSet";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "previousEpoch";
        readonly indexed: true;
    }, {
        readonly type: "uint64";
        readonly name: "nextEpoch";
        readonly indexed: true;
    }];
}, {
    readonly name: "Initialized";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "height";
    }];
}, {
    readonly name: "SkippedValidatorMigration";
    readonly type: "event";
    readonly inputs: readonly [{
        readonly type: "uint64";
        readonly name: "index";
        readonly indexed: true;
    }, {
        readonly type: "address";
        readonly name: "validatorAddress";
        readonly indexed: true;
    }, {
        readonly type: "bytes32";
        readonly name: "publicKey";
    }];
}, {
    readonly name: "AlreadyInitialized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "IngressAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "ingress";
    }];
}, {
    readonly name: "EmptyV1ValidatorSet";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidMigrationIndex";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidOwner";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidPublicKey";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignature";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidSignatureFormat";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "InvalidValidatorAddress";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "MigrationNotComplete";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NotInitialized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "NotIp";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "input";
    }, {
        readonly type: "string";
        readonly name: "backtrace";
    }];
}, {
    readonly name: "NotIpPort";
    readonly type: "error";
    readonly inputs: readonly [{
        readonly type: "string";
        readonly name: "input";
    }, {
        readonly type: "string";
        readonly name: "backtrace";
    }];
}, {
    readonly name: "PublicKeyAlreadyExists";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "Unauthorized";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "AddressAlreadyHasValidator";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ValidatorAlreadyDeactivated";
    readonly type: "error";
    readonly inputs: readonly [];
}, {
    readonly name: "ValidatorNotFound";
    readonly type: "error";
    readonly inputs: readonly [];
}];
export declare const erc4626EngineFactory: readonly [{
    readonly type: "function";
    readonly name: "computeEngineSalt";
    readonly inputs: readonly [{
        readonly name: "deploymentId";
        readonly type: "bytes32";
    }, {
        readonly name: "vault";
        readonly type: "address";
    }, {
        readonly name: "owner";
        readonly type: "address";
    }, {
        readonly name: "nameOverride";
        readonly type: "string";
    }, {
        readonly name: "symbolOverride";
        readonly type: "string";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
    }];
    readonly stateMutability: "pure";
}, {
    readonly type: "function";
    readonly name: "deploy";
    readonly inputs: readonly [{
        readonly name: "deploymentId";
        readonly type: "bytes32";
    }, {
        readonly name: "vault";
        readonly type: "address";
    }, {
        readonly name: "owner";
        readonly type: "address";
    }, {
        readonly name: "nameOverride";
        readonly type: "string";
    }, {
        readonly name: "symbolOverride";
        readonly type: "string";
    }];
    readonly outputs: readonly [{
        readonly name: "engine";
        readonly type: "address";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "predictEngine";
    readonly inputs: readonly [{
        readonly name: "deploymentId";
        readonly type: "bytes32";
    }, {
        readonly name: "vault";
        readonly type: "address";
    }, {
        readonly name: "owner";
        readonly type: "address";
    }, {
        readonly name: "nameOverride";
        readonly type: "string";
    }, {
        readonly name: "symbolOverride";
        readonly type: "string";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "event";
    readonly name: "ERC4626EngineDeployed";
    readonly inputs: readonly [{
        readonly name: "engine";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "vault";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "owner";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "asset";
        readonly type: "address";
        readonly indexed: false;
    }, {
        readonly name: "deploymentId";
        readonly type: "bytes32";
        readonly indexed: false;
    }, {
        readonly name: "engineSalt";
        readonly type: "bytes32";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "error";
    readonly name: "EmptyDeploymentId";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "EngineAlreadyExists";
    readonly inputs: readonly [{
        readonly name: "engine";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "FactoryCannotBeFinalOwner";
    readonly inputs: readonly [];
}];
export declare const earnFactory: readonly [{
    readonly type: "function";
    readonly name: "computeEarnShareSalt";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "deploymentId";
            readonly type: "bytes32";
        }, {
            readonly name: "engine";
            readonly type: "address";
        }, {
            readonly name: "owner";
            readonly type: "address";
        }, {
            readonly name: "controls";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "emergencyGuardian";
                readonly type: "address";
            }, {
                readonly name: "asyncJanitor";
                readonly type: "address";
            }, {
                readonly name: "maxManagedAssets";
                readonly type: "uint256";
            }, {
                readonly name: "migrationMode";
                readonly type: "uint8";
            }];
        }, {
            readonly name: "distributorConfig";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "distributor";
                readonly type: "address";
            }, {
                readonly name: "updateDelay";
                readonly type: "uint40";
            }];
        }, {
            readonly name: "fees";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "fixedFeeCount";
                readonly type: "uint8";
            }, {
                readonly name: "fixedFees";
                readonly type: "tuple[4]";
                readonly components: readonly [{
                    readonly name: "account";
                    readonly type: "address";
                }, {
                    readonly name: "rateBps";
                    readonly type: "uint16";
                }];
            }, {
                readonly name: "excess";
                readonly type: "tuple";
                readonly components: readonly [{
                    readonly name: "enabled";
                    readonly type: "bool";
                }, {
                    readonly name: "account";
                    readonly type: "address";
                }, {
                    readonly name: "annualTargetRateBps";
                    readonly type: "uint16";
                }, {
                    readonly name: "excessFeeRateBps";
                    readonly type: "uint16";
                }];
            }];
        }, {
            readonly name: "transferPolicyId";
            readonly type: "uint64";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes32";
    }];
    readonly stateMutability: "pure";
}, {
    readonly type: "function";
    readonly name: "deploy";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "deploymentId";
            readonly type: "bytes32";
        }, {
            readonly name: "engine";
            readonly type: "address";
        }, {
            readonly name: "owner";
            readonly type: "address";
        }, {
            readonly name: "controls";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "emergencyGuardian";
                readonly type: "address";
            }, {
                readonly name: "asyncJanitor";
                readonly type: "address";
            }, {
                readonly name: "maxManagedAssets";
                readonly type: "uint256";
            }, {
                readonly name: "migrationMode";
                readonly type: "uint8";
            }];
        }, {
            readonly name: "distributorConfig";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "distributor";
                readonly type: "address";
            }, {
                readonly name: "updateDelay";
                readonly type: "uint40";
            }];
        }, {
            readonly name: "fees";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "fixedFeeCount";
                readonly type: "uint8";
            }, {
                readonly name: "fixedFees";
                readonly type: "tuple[4]";
                readonly components: readonly [{
                    readonly name: "account";
                    readonly type: "address";
                }, {
                    readonly name: "rateBps";
                    readonly type: "uint16";
                }];
            }, {
                readonly name: "excess";
                readonly type: "tuple";
                readonly components: readonly [{
                    readonly name: "enabled";
                    readonly type: "bool";
                }, {
                    readonly name: "account";
                    readonly type: "address";
                }, {
                    readonly name: "annualTargetRateBps";
                    readonly type: "uint16";
                }, {
                    readonly name: "excessFeeRateBps";
                    readonly type: "uint16";
                }];
            }];
        }, {
            readonly name: "transferPolicyId";
            readonly type: "uint64";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "earnShare";
        readonly type: "address";
    }, {
        readonly name: "earnVault";
        readonly type: "address";
    }, {
        readonly name: "earnFees";
        readonly type: "address";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "earnFeesImplementation";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "earnVaultImplementation";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "predictEarnFees";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "deploymentId";
            readonly type: "bytes32";
        }, {
            readonly name: "engine";
            readonly type: "address";
        }, {
            readonly name: "owner";
            readonly type: "address";
        }, {
            readonly name: "controls";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "emergencyGuardian";
                readonly type: "address";
            }, {
                readonly name: "asyncJanitor";
                readonly type: "address";
            }, {
                readonly name: "maxManagedAssets";
                readonly type: "uint256";
            }, {
                readonly name: "migrationMode";
                readonly type: "uint8";
            }];
        }, {
            readonly name: "distributorConfig";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "distributor";
                readonly type: "address";
            }, {
                readonly name: "updateDelay";
                readonly type: "uint40";
            }];
        }, {
            readonly name: "fees";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "fixedFeeCount";
                readonly type: "uint8";
            }, {
                readonly name: "fixedFees";
                readonly type: "tuple[4]";
                readonly components: readonly [{
                    readonly name: "account";
                    readonly type: "address";
                }, {
                    readonly name: "rateBps";
                    readonly type: "uint16";
                }];
            }, {
                readonly name: "excess";
                readonly type: "tuple";
                readonly components: readonly [{
                    readonly name: "enabled";
                    readonly type: "bool";
                }, {
                    readonly name: "account";
                    readonly type: "address";
                }, {
                    readonly name: "annualTargetRateBps";
                    readonly type: "uint16";
                }, {
                    readonly name: "excessFeeRateBps";
                    readonly type: "uint16";
                }];
            }];
        }, {
            readonly name: "transferPolicyId";
            readonly type: "uint64";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "predictEarnShare";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "deploymentId";
            readonly type: "bytes32";
        }, {
            readonly name: "engine";
            readonly type: "address";
        }, {
            readonly name: "owner";
            readonly type: "address";
        }, {
            readonly name: "controls";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "emergencyGuardian";
                readonly type: "address";
            }, {
                readonly name: "asyncJanitor";
                readonly type: "address";
            }, {
                readonly name: "maxManagedAssets";
                readonly type: "uint256";
            }, {
                readonly name: "migrationMode";
                readonly type: "uint8";
            }];
        }, {
            readonly name: "distributorConfig";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "distributor";
                readonly type: "address";
            }, {
                readonly name: "updateDelay";
                readonly type: "uint40";
            }];
        }, {
            readonly name: "fees";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "fixedFeeCount";
                readonly type: "uint8";
            }, {
                readonly name: "fixedFees";
                readonly type: "tuple[4]";
                readonly components: readonly [{
                    readonly name: "account";
                    readonly type: "address";
                }, {
                    readonly name: "rateBps";
                    readonly type: "uint16";
                }];
            }, {
                readonly name: "excess";
                readonly type: "tuple";
                readonly components: readonly [{
                    readonly name: "enabled";
                    readonly type: "bool";
                }, {
                    readonly name: "account";
                    readonly type: "address";
                }, {
                    readonly name: "annualTargetRateBps";
                    readonly type: "uint16";
                }, {
                    readonly name: "excessFeeRateBps";
                    readonly type: "uint16";
                }];
            }];
        }, {
            readonly name: "transferPolicyId";
            readonly type: "uint64";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "tip20Factory";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "event";
    readonly name: "EarnStackDeployed";
    readonly inputs: readonly [{
        readonly name: "earnVault";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "earnShare";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "earnFees";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "engine";
        readonly type: "address";
        readonly indexed: false;
    }, {
        readonly name: "asset";
        readonly type: "address";
        readonly indexed: false;
    }, {
        readonly name: "owner";
        readonly type: "address";
        readonly indexed: false;
    }, {
        readonly name: "deploymentId";
        readonly type: "bytes32";
        readonly indexed: false;
    }, {
        readonly name: "emergencyGuardian";
        readonly type: "address";
        readonly indexed: false;
    }, {
        readonly name: "asyncJanitor";
        readonly type: "address";
        readonly indexed: false;
    }, {
        readonly name: "maxManagedAssets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "migrationMode";
        readonly type: "uint8";
        readonly indexed: false;
    }, {
        readonly name: "transferPolicyId";
        readonly type: "uint64";
        readonly indexed: false;
    }, {
        readonly name: "earnShareSalt";
        readonly type: "bytes32";
        readonly indexed: false;
    }, {
        readonly name: "controlConfigHash";
        readonly type: "bytes32";
        readonly indexed: false;
    }, {
        readonly name: "feeConfigHash";
        readonly type: "bytes32";
        readonly indexed: false;
    }, {
        readonly name: "earnFeesSalt";
        readonly type: "bytes32";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "error";
    readonly name: "AdminHandoffFailed";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "EarnShareAlreadyExists";
    readonly inputs: readonly [{
        readonly name: "earnShare";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "EarnShareSupplyNotZero";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "EmptyDeploymentId";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "EmptyEarnShareMetadata";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "EngineAlreadyBound";
    readonly inputs: readonly [{
        readonly name: "earnVault";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "FactoryCannotBeFinalOwner";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "FailedDeployment";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InsufficientBalance";
    readonly inputs: readonly [{
        readonly name: "balance";
        readonly type: "uint256";
    }, {
        readonly name: "needed";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "InvalidDistributorConfig";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidEarnFeesImplementation";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidEarnVaultImplementation";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidEngine";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidTransferPolicy";
    readonly inputs: readonly [{
        readonly name: "policyId";
        readonly type: "uint64";
    }];
}, {
    readonly type: "error";
    readonly name: "IssuerGrantFailed";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "TransferPolicyMismatch";
    readonly inputs: readonly [{
        readonly name: "expected";
        readonly type: "uint64";
    }, {
        readonly name: "actual";
        readonly type: "uint64";
    }];
}, {
    readonly type: "error";
    readonly name: "UnsupportedTransferPolicy";
    readonly inputs: readonly [{
        readonly name: "policyId";
        readonly type: "uint64";
    }, {
        readonly name: "policyType";
        readonly type: "uint8";
    }];
}, {
    readonly type: "error";
    readonly name: "ZeroAddress";
    readonly inputs: readonly [];
}];
export declare const erc4626Engine: readonly [{
    readonly type: "function";
    readonly name: "acceptOwnership";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "asset";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "baseAsset";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "earnVault";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "initializeEarnVault";
    readonly inputs: readonly [{
        readonly name: "earnVault_";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "name";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "string";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "owner";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "pendingOwner";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "renounceOwnership";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "symbol";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "string";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "transferOwnership";
    readonly inputs: readonly [{
        readonly name: "newOwner";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "vault";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "event";
    readonly name: "Deposited";
    readonly inputs: readonly [{
        readonly name: "earnVault";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "assets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "engineShares";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "EarnVaultInitialized";
    readonly inputs: readonly [{
        readonly name: "earnVault";
        readonly type: "address";
        readonly indexed: true;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "OwnershipTransferStarted";
    readonly inputs: readonly [{
        readonly name: "previousOwner";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "newOwner";
        readonly type: "address";
        readonly indexed: true;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "OwnershipTransferred";
    readonly inputs: readonly [{
        readonly name: "previousOwner";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "newOwner";
        readonly type: "address";
        readonly indexed: true;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "Redeemed";
    readonly inputs: readonly [{
        readonly name: "receiver";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "engineShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "assets";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "VenueSharesDeposited";
    readonly inputs: readonly [{
        readonly name: "from";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "requestedVenueShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "receivedEngineShares";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "WithdrewExact";
    readonly inputs: readonly [{
        readonly name: "receiver";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "assets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "engineSharesBurned";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "error";
    readonly name: "AlreadyInitialized";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "EarnVaultNotSet";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "EmptyMetadata";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InsufficientAssetsReceived";
    readonly inputs: readonly [{
        readonly name: "minimumAssets";
        readonly type: "uint256";
    }, {
        readonly name: "actualAssets";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "InvalidVenueShareDecimals";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NoVenueSharesReceived";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotEarnVault";
    readonly inputs: readonly [{
        readonly name: "caller";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "OwnableInvalidOwner";
    readonly inputs: readonly [{
        readonly name: "owner";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "OwnableUnauthorizedAccount";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "ReentrantCall";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "TransferFailed";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "UnexpectedAssetsReceived";
    readonly inputs: readonly [{
        readonly name: "expectedAssets";
        readonly type: "uint256";
    }, {
        readonly name: "actualAssets";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "UnexpectedVenueSharesBurned";
    readonly inputs: readonly [{
        readonly name: "expectedShares";
        readonly type: "uint256";
    }, {
        readonly name: "actualShares";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "ZeroAddress";
    readonly inputs: readonly [];
}];
export declare const earnVault: readonly [{
    readonly type: "constructor";
    readonly inputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "acceptDistributor";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "accrueFees";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "feeAssets";
        readonly type: "uint256";
    }, {
        readonly name: "feeEarnShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "anchorEarnShares";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "anchorEngineShares";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "asset";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "asyncJanitor";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "cancelDistributorFeeUpdate";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "cancelDistributorTransfer";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "cancelRedeem";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }, {
        readonly name: "minReceiverEarnShares";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "contribute";
    readonly inputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "receivedEngineShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "convertEngineSharesToEarnShares";
    readonly inputs: readonly [{
        readonly name: "engineShares_";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "earnShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "convertToEngineShares";
    readonly inputs: readonly [{
        readonly name: "earnShares";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "engineShares_";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "deposit";
    readonly inputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "minEarnShares";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "earnShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "depositVenueShares";
    readonly inputs: readonly [{
        readonly name: "venueShares";
        readonly type: "uint256";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "minEarnShares";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "earnShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "depositsPaused";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "disableFees";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "distributor";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "distributorFee";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "recipient";
        readonly type: "address";
    }, {
        readonly name: "rateBps";
        readonly type: "uint16";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "distributorUpdateDelay";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint40";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "earnFees";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "earnShare";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "emergencyGuardian";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "engine";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "engineMigrationMode";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "engineShares";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "executeDistributorFeeUpdate";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "feeConfigId";
        readonly type: "uint64";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "finalizeRedeem";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }, {
        readonly name: "asset_";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "initialize";
    readonly inputs: readonly [{
        readonly name: "engine_";
        readonly type: "address";
    }, {
        readonly name: "earnShare_";
        readonly type: "address";
    }, {
        readonly name: "earnFees_";
        readonly type: "address";
    }, {
        readonly name: "operator_";
        readonly type: "address";
    }, {
        readonly name: "controlInit_";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "emergencyGuardian";
            readonly type: "address";
        }, {
            readonly name: "asyncJanitor";
            readonly type: "address";
        }, {
            readonly name: "maxManagedAssets";
            readonly type: "uint256";
        }, {
            readonly name: "migrationMode";
            readonly type: "uint8";
        }];
    }, {
        readonly name: "distributorInit_";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "distributor";
            readonly type: "address";
        }, {
            readonly name: "updateDelay";
            readonly type: "uint40";
        }];
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "isAccountingAligned";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "maxManagedAssets";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "migrateEngine";
    readonly inputs: readonly [{
        readonly name: "newEngine";
        readonly type: "address";
    }, {
        readonly name: "minNewEngineShares";
        readonly type: "uint256";
    }, {
        readonly name: "minAssetsRetained";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "newEngineShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "openRedeemRequestCount";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "operator";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "pendingDistributor";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "pendingDistributorFeeUpdate";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "recipient";
            readonly type: "address";
        }, {
            readonly name: "rateBps";
            readonly type: "uint16";
        }, {
            readonly name: "executableAt";
            readonly type: "uint40";
        }, {
            readonly name: "pending";
            readonly type: "bool";
        }];
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "pendingRedeem";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "receiver";
            readonly type: "address";
        }, {
            readonly name: "requester";
            readonly type: "address";
        }, {
            readonly name: "burnedEarnShares";
            readonly type: "uint256";
        }, {
            readonly name: "engineShares";
            readonly type: "uint256";
        }, {
            readonly name: "open";
            readonly type: "bool";
        }];
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "previewRedeem";
    readonly inputs: readonly [{
        readonly name: "earnShares";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "previewWithdraw";
    readonly inputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "earnShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "redeem";
    readonly inputs: readonly [{
        readonly name: "earnShares";
        readonly type: "uint256";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "minAssets";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "remainingDepositCapacity";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "requestRedeem";
    readonly inputs: readonly [{
        readonly name: "earnShares";
        readonly type: "uint256";
    }, {
        readonly name: "engineData";
        readonly type: "bytes";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "scheduleDistributorFeeUpdate";
    readonly inputs: readonly [{
        readonly name: "recipient";
        readonly type: "address";
    }, {
        readonly name: "rateBps";
        readonly type: "uint16";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "setDepositsPaused";
    readonly inputs: readonly [{
        readonly name: "paused";
        readonly type: "bool";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "setEmergencyRoles";
    readonly inputs: readonly [{
        readonly name: "newGuardian";
        readonly type: "address";
    }, {
        readonly name: "newJanitor";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "setFeeConfig";
    readonly inputs: readonly [{
        readonly name: "config";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "fixedFeeCount";
            readonly type: "uint8";
        }, {
            readonly name: "fixedFees";
            readonly type: "tuple[4]";
            readonly components: readonly [{
                readonly name: "account";
                readonly type: "address";
            }, {
                readonly name: "rateBps";
                readonly type: "uint16";
            }];
        }, {
            readonly name: "excess";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "enabled";
                readonly type: "bool";
            }, {
                readonly name: "account";
                readonly type: "address";
            }, {
                readonly name: "annualTargetRateBps";
                readonly type: "uint16";
            }, {
                readonly name: "excessFeeRateBps";
                readonly type: "uint16";
            }];
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "configId";
        readonly type: "uint64";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "setMaxManagedAssets";
    readonly inputs: readonly [{
        readonly name: "newMaxManagedAssets";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "totalEarnShares";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "transferDistributor";
    readonly inputs: readonly [{
        readonly name: "newDistributor";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "withdrawExact";
    readonly inputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "maxEarnShares";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "earnSharesBurned";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "event";
    readonly name: "Contributed";
    readonly inputs: readonly [{
        readonly name: "caller";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "assets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "engineShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "anchorEngineShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "anchorEarnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "DepositPauseChanged";
    readonly inputs: readonly [{
        readonly name: "caller";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "paused";
        readonly type: "bool";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "Deposited";
    readonly inputs: readonly [{
        readonly name: "caller";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "receiver";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "assets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "earnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "DistributorFeeUpdateCancelled";
    readonly inputs: readonly [{
        readonly name: "distributor";
        readonly type: "address";
        readonly indexed: true;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "DistributorFeeUpdateScheduled";
    readonly inputs: readonly [{
        readonly name: "distributor";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "recipient";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "rateBps";
        readonly type: "uint16";
        readonly indexed: false;
    }, {
        readonly name: "executableAt";
        readonly type: "uint40";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "DistributorFeeUpdated";
    readonly inputs: readonly [{
        readonly name: "recipient";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "rateBps";
        readonly type: "uint16";
        readonly indexed: false;
    }, {
        readonly name: "feeConfigId";
        readonly type: "uint64";
        readonly indexed: true;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "DistributorTransferCancelled";
    readonly inputs: readonly [{
        readonly name: "distributor";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "pendingDistributor";
        readonly type: "address";
        readonly indexed: true;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "DistributorTransferStarted";
    readonly inputs: readonly [{
        readonly name: "distributor";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "pendingDistributor";
        readonly type: "address";
        readonly indexed: true;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "DistributorTransferred";
    readonly inputs: readonly [{
        readonly name: "previousDistributor";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "newDistributor";
        readonly type: "address";
        readonly indexed: true;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "EmergencyRolesChanged";
    readonly inputs: readonly [{
        readonly name: "emergencyGuardian";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "asyncJanitor";
        readonly type: "address";
        readonly indexed: true;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "EngineMigrated";
    readonly inputs: readonly [{
        readonly name: "oldEngine";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "newEngine";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "oldEngineShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "assetsMoved";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "newEngineShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "totalEarnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "anchorEngineShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "anchorEarnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "MaxManagedAssetsChanged";
    readonly inputs: readonly [{
        readonly name: "previousMaxManagedAssets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "newMaxManagedAssets";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "RedeemCancelled";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
        readonly indexed: true;
    }, {
        readonly name: "receiver";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "earnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "RedeemFinalized";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
        readonly indexed: true;
    }, {
        readonly name: "receiver";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "earnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "asset";
        readonly type: "address";
        readonly indexed: false;
    }, {
        readonly name: "assets";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "RedeemRequested";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
        readonly indexed: true;
    }, {
        readonly name: "requester";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "receiver";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "earnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "Redeemed";
    readonly inputs: readonly [{
        readonly name: "caller";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "receiver";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "earnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "assets";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "VenueSharesDeposited";
    readonly inputs: readonly [{
        readonly name: "caller";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "receiver";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "requestedVenueShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "receivedEngineShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "earnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "WithdrewExact";
    readonly inputs: readonly [{
        readonly name: "caller";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "receiver";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "assets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "earnSharesBurned";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "error";
    readonly name: "ActiveSupplyWithoutBacking";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "AlreadyInitialized";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "DepositsPaused";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "DistributorFeeUpdateNotPending";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "DistributorFeeUpdateNotReady";
    readonly inputs: readonly [{
        readonly name: "executableAt";
        readonly type: "uint40";
    }];
}, {
    readonly type: "error";
    readonly name: "DistributorTransferNotPending";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "DuplicateRequest";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
}, {
    readonly type: "error";
    readonly name: "EngineAssetMismatch";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "EngineCapabilityUnsupported";
    readonly inputs: readonly [{
        readonly name: "interfaceId";
        readonly type: "bytes4";
    }];
}, {
    readonly type: "error";
    readonly name: "EngineExitUnsupported";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ExceedsMaxEarnShares";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ExcessiveConversionLoss";
    readonly inputs: readonly [{
        readonly name: "inputShares";
        readonly type: "uint256";
    }, {
        readonly name: "representedShares";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "FinalizedAssetMismatch";
    readonly inputs: readonly [{
        readonly name: "finalizedAsset";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "GlobalFeeDisableUnavailable";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InitialEarnShareSupplyNotZero";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InsufficientOutput";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidDistributorConfiguration";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidDistributorFeeConfiguration";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidEarnDecimals";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidEngineShareScale";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "MaxManagedAssetsExceeded";
    readonly inputs: readonly [{
        readonly name: "maximum";
        readonly type: "uint256";
    }, {
        readonly name: "actual";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "MinimumAssetsNotMet";
    readonly inputs: readonly [{
        readonly name: "minimumAssets";
        readonly type: "uint256";
    }, {
        readonly name: "actualAssets";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "MinimumEarnSharesNotMet";
    readonly inputs: readonly [{
        readonly name: "minimumEarnShares";
        readonly type: "uint256";
    }, {
        readonly name: "actualEarnShares";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "MinimumEngineSharesNotMet";
    readonly inputs: readonly [{
        readonly name: "minimumEngineShares";
        readonly type: "uint256";
    }, {
        readonly name: "actualEngineShares";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "NoEarnShares";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotDistributor";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotEmergencyGuardianOrOperator";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotEngine";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotOperator";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotPendingDistributor";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotRequesterOrJanitor";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "OperatorMigrationDisabled";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "PendingRedeemsOpen";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ReentrantCall";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "RequestNotOpen";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
}, {
    readonly type: "error";
    readonly name: "ResidualBacking";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "SameEngine";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "TokenCallFailed";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "TokenCallFalse";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ZeroAddress";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ZeroAmount";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ZeroMinimumAssets";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ZeroMinimumEarnShares";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ZeroMinimumEngineShares";
    readonly inputs: readonly [];
}];
export declare const earnFees: readonly [{
    readonly type: "constructor";
    readonly inputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "accrueFees";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "result";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "activeAssets";
            readonly type: "uint256";
        }, {
            readonly name: "positiveAccrualAssets";
            readonly type: "uint256";
        }, {
            readonly name: "fixedFeeAssets";
            readonly type: "uint256";
        }, {
            readonly name: "excessFeeAssets";
            readonly type: "uint256";
        }, {
            readonly name: "totalFeeAssets";
            readonly type: "uint256";
        }, {
            readonly name: "totalFeeEarnShares";
            readonly type: "uint256";
        }, {
            readonly name: "preFeeValuePerEarnShare";
            readonly type: "uint256";
        }, {
            readonly name: "postFeeValuePerEarnShare";
            readonly type: "uint256";
        }, {
            readonly name: "targetValuePerEarnShare";
            readonly type: "uint256";
        }, {
            readonly name: "allocationCount";
            readonly type: "uint8";
        }, {
            readonly name: "allocations";
            readonly type: "tuple[5]";
            readonly components: readonly [{
                readonly name: "account";
                readonly type: "address";
            }, {
                readonly name: "feeAssets";
                readonly type: "uint256";
            }, {
                readonly name: "feeEarnShares";
                readonly type: "uint256";
            }];
        }];
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "claim";
    readonly inputs: readonly [{
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "earnShares";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "claimableEarnShares";
    readonly inputs: readonly [{
        readonly name: "recipient";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "earnShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "closeRedeemRequest";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "currentFeeConfigId";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint64";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "disableFees";
    readonly inputs: readonly [{
        readonly name: "operator";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "earnShare";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "earnShareScale";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "earnVault";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "feeConfig";
    readonly inputs: readonly [{
        readonly name: "configId";
        readonly type: "uint64";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "fixedFeeCount";
            readonly type: "uint8";
        }, {
            readonly name: "fixedFees";
            readonly type: "tuple[4]";
            readonly components: readonly [{
                readonly name: "account";
                readonly type: "address";
            }, {
                readonly name: "rateBps";
                readonly type: "uint16";
            }];
        }, {
            readonly name: "excess";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "enabled";
                readonly type: "bool";
            }, {
                readonly name: "account";
                readonly type: "address";
            }, {
                readonly name: "annualTargetRateBps";
                readonly type: "uint16";
            }, {
                readonly name: "excessFeeRateBps";
                readonly type: "uint16";
            }];
        }];
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "feeRemainder";
    readonly inputs: readonly [{
        readonly name: "configId";
        readonly type: "uint64";
    }, {
        readonly name: "slot";
        readonly type: "uint8";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "feesActive";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "feesDisabled";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "highWaterMark";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "initialize";
    readonly inputs: readonly [{
        readonly name: "earnVault_";
        readonly type: "address";
    }, {
        readonly name: "earnShare_";
        readonly type: "address";
    }, {
        readonly name: "initialConfig";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "fixedFeeCount";
            readonly type: "uint8";
        }, {
            readonly name: "fixedFees";
            readonly type: "tuple[4]";
            readonly components: readonly [{
                readonly name: "account";
                readonly type: "address";
            }, {
                readonly name: "rateBps";
                readonly type: "uint16";
            }];
        }, {
            readonly name: "excess";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "enabled";
                readonly type: "bool";
            }, {
                readonly name: "account";
                readonly type: "address";
            }, {
                readonly name: "annualTargetRateBps";
                readonly type: "uint16";
            }, {
                readonly name: "excessFeeRateBps";
                readonly type: "uint16";
            }];
        }];
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "initializeBaselines";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "pendingFeeSnapshot";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "burnedEarnShares";
            readonly type: "uint256";
        }, {
            readonly name: "requestValue";
            readonly type: "uint256";
        }, {
            readonly name: "highWaterValue";
            readonly type: "uint256";
        }, {
            readonly name: "targetValue";
            readonly type: "uint256";
        }, {
            readonly name: "feeConfigId";
            readonly type: "uint64";
        }, {
            readonly name: "requestedAt";
            readonly type: "uint40";
        }, {
            readonly name: "open";
            readonly type: "bool";
        }];
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "previewAccruedFees";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "result";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "activeAssets";
            readonly type: "uint256";
        }, {
            readonly name: "positiveAccrualAssets";
            readonly type: "uint256";
        }, {
            readonly name: "fixedFeeAssets";
            readonly type: "uint256";
        }, {
            readonly name: "excessFeeAssets";
            readonly type: "uint256";
        }, {
            readonly name: "totalFeeAssets";
            readonly type: "uint256";
        }, {
            readonly name: "totalFeeEarnShares";
            readonly type: "uint256";
        }, {
            readonly name: "preFeeValuePerEarnShare";
            readonly type: "uint256";
        }, {
            readonly name: "postFeeValuePerEarnShare";
            readonly type: "uint256";
        }, {
            readonly name: "targetValuePerEarnShare";
            readonly type: "uint256";
        }, {
            readonly name: "allocationCount";
            readonly type: "uint8";
        }, {
            readonly name: "allocations";
            readonly type: "tuple[5]";
            readonly components: readonly [{
                readonly name: "account";
                readonly type: "address";
            }, {
                readonly name: "feeAssets";
                readonly type: "uint256";
            }, {
                readonly name: "feeEarnShares";
                readonly type: "uint256";
            }];
        }];
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "recordRedeemRequest";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }, {
        readonly name: "burnedEarnShares";
        readonly type: "uint256";
    }, {
        readonly name: "requestValue";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "setFeeConfig";
    readonly inputs: readonly [{
        readonly name: "config";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "fixedFeeCount";
            readonly type: "uint8";
        }, {
            readonly name: "fixedFees";
            readonly type: "tuple[4]";
            readonly components: readonly [{
                readonly name: "account";
                readonly type: "address";
            }, {
                readonly name: "rateBps";
                readonly type: "uint16";
            }];
        }, {
            readonly name: "excess";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "enabled";
                readonly type: "bool";
            }, {
                readonly name: "account";
                readonly type: "address";
            }, {
                readonly name: "annualTargetRateBps";
                readonly type: "uint16";
            }, {
                readonly name: "excessFeeRateBps";
                readonly type: "uint16";
            }];
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "configId";
        readonly type: "uint64";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "settleCancelledRedeem";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }, {
        readonly name: "returnedValue";
        readonly type: "uint256";
    }, {
        readonly name: "activeSupply";
        readonly type: "uint256";
    }, {
        readonly name: "activeAssets";
        readonly type: "uint256";
    }, {
        readonly name: "totalReentryEarnShares";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "feeEarnShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "shouldChargeRedeem";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "targetBase";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "targetStartedAt";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint40";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "totalClaimableEarnShares";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "validateFeeConfig";
    readonly inputs: readonly [{
        readonly name: "config";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "fixedFeeCount";
            readonly type: "uint8";
        }, {
            readonly name: "fixedFees";
            readonly type: "tuple[4]";
            readonly components: readonly [{
                readonly name: "account";
                readonly type: "address";
            }, {
                readonly name: "rateBps";
                readonly type: "uint16";
            }];
        }, {
            readonly name: "excess";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "enabled";
                readonly type: "bool";
            }, {
                readonly name: "account";
                readonly type: "address";
            }, {
                readonly name: "annualTargetRateBps";
                readonly type: "uint16";
            }, {
                readonly name: "excessFeeRateBps";
                readonly type: "uint16";
            }];
        }];
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "view";
}, {
    readonly type: "event";
    readonly name: "FeeBaselinesInitialized";
    readonly inputs: readonly [{
        readonly name: "highWaterMark";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "targetBase";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "targetStartedAt";
        readonly type: "uint40";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "FeeConfigurationSet";
    readonly inputs: readonly [{
        readonly name: "configId";
        readonly type: "uint64";
        readonly indexed: true;
    }, {
        readonly name: "configHash";
        readonly type: "bytes32";
        readonly indexed: true;
    }, {
        readonly name: "reactivated";
        readonly type: "bool";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "FeeDustWaived";
    readonly inputs: readonly [{
        readonly name: "configId";
        readonly type: "uint64";
        readonly indexed: true;
    }, {
        readonly name: "slot";
        readonly type: "uint8";
        readonly indexed: true;
    }, {
        readonly name: "remainder";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "FeeEarnSharesAllocated";
    readonly inputs: readonly [{
        readonly name: "configId";
        readonly type: "uint64";
        readonly indexed: true;
    }, {
        readonly name: "recipient";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "feeAssets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "feeEarnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "FeeEarnSharesClaimed";
    readonly inputs: readonly [{
        readonly name: "recipient";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "to";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "earnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "FeesAccrued";
    readonly inputs: readonly [{
        readonly name: "configId";
        readonly type: "uint64";
        readonly indexed: true;
    }, {
        readonly name: "activeAssets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "positiveAccrualAssets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "feeAssets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "feeEarnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "highWaterMark";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "targetValuePerEarnShare";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "FeesDisabled";
    readonly inputs: readonly [{
        readonly name: "operator";
        readonly type: "address";
        readonly indexed: true;
    }];
    readonly anonymous: false;
}, {
    readonly type: "error";
    readonly name: "AlreadyInitialized";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InsufficientClaimableEarnShares";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidFeeClaimReceiver";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidFeeConfiguration";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotEarnVault";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ReentrantCall";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ZeroAddress";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ZeroAmount";
    readonly inputs: readonly [];
}];
export declare const earnEngine: readonly [{
    readonly type: "function";
    readonly name: "asset";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "deposit";
    readonly inputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "engineShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "earnVault";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "name";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "string";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "shareScale";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "scale";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "supportsInterface";
    readonly inputs: readonly [{
        readonly name: "interfaceId";
        readonly type: "bytes4";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "symbol";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "string";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "totalAssets";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "totalShares";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "engineShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "valueOf";
    readonly inputs: readonly [{
        readonly name: "engineShares";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "previewRedeem";
    readonly inputs: readonly [{
        readonly name: "engineShares";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "redeem";
    readonly inputs: readonly [{
        readonly name: "engineShares";
        readonly type: "uint256";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "minAssets";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "previewWithdraw";
    readonly inputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "engineShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "withdraw";
    readonly inputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "engineShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}];
export declare const earnEngineAsyncRedeem: readonly [{
    readonly type: "function";
    readonly name: "cancelRedeem";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
    readonly outputs: readonly [{
        readonly name: "engineShares";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "requestRedeem";
    readonly inputs: readonly [{
        readonly name: "engineShares";
        readonly type: "uint256";
    }, {
        readonly name: "requestData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
    readonly stateMutability: "nonpayable";
}];
export declare const earnEngineInKindDeposit: readonly [{
    readonly type: "function";
    readonly name: "depositInKind";
    readonly inputs: readonly [{
        readonly name: "venueShares";
        readonly type: "uint256";
    }, {
        readonly name: "from";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "engineSharesReceived";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}];
export declare const earnContributionController: readonly [{
    readonly type: "function";
    readonly name: "active";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "fund";
    readonly inputs: readonly [{
        readonly name: "funder";
        readonly type: "address";
    }, {
        readonly name: "requestedAssets";
        readonly type: "uint256";
    }, {
        readonly name: "maxEarnShareSupply";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "fundedAssets";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "setActive";
    readonly inputs: readonly [{
        readonly name: "active_";
        readonly type: "bool";
    }];
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "event";
    readonly name: "Funded";
    readonly inputs: readonly [{
        readonly name: "funder";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "requestedAssets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "fundedAssets";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "error";
    readonly name: "EarnShareSupplyOutOfBounds";
    readonly inputs: readonly [{
        readonly name: "earnShareSupply";
        readonly type: "uint256";
    }, {
        readonly name: "maxEarnShareSupply";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "Inactive";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotSelf";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "OwnableInvalidOwner";
    readonly inputs: readonly [{
        readonly name: "owner";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "OwnableUnauthorizedAccount";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "ReentrantCall";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "TokenCallFailed";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "TokenCallFalse";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ZeroAddress";
    readonly inputs: readonly [];
}];
export declare const vedaEngine: readonly [{
    readonly type: "function";
    readonly name: "claimRedeem";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
    readonly outputs: readonly [{
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "getClaim";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
    readonly outputs: readonly [{
        readonly name: "status";
        readonly type: "uint8";
    }, {
        readonly name: "request";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "nonce";
            readonly type: "uint96";
        }, {
            readonly name: "user";
            readonly type: "address";
        }, {
            readonly name: "assetOut";
            readonly type: "address";
        }, {
            readonly name: "amountOfShares";
            readonly type: "uint128";
        }, {
            readonly name: "amountOfAssets";
            readonly type: "uint128";
        }, {
            readonly name: "creationTime";
            readonly type: "uint40";
        }, {
            readonly name: "secondsToMaturity";
            readonly type: "uint24";
        }, {
            readonly name: "secondsToDeadline";
            readonly type: "uint24";
        }];
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "rate";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "settled";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "event";
    readonly name: "AuthorizedForwarderChanged";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "authorized";
        readonly type: "bool";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "Deposited";
    readonly inputs: readonly [{
        readonly name: "earnVault";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "assets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "engineShares";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "DustSwept";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "to";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "amount";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "EarnVaultInitialized";
    readonly inputs: readonly [{
        readonly name: "earnVault";
        readonly type: "address";
        readonly indexed: true;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "FinalizeFailed";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
        readonly indexed: true;
    }, {
        readonly name: "asset";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "amount";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "Finalized";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
        readonly indexed: true;
    }, {
        readonly name: "asset";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "amount";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "MaxRateAgeUpdated";
    readonly inputs: readonly [{
        readonly name: "oldMaxRateAge";
        readonly type: "uint64";
        readonly indexed: false;
    }, {
        readonly name: "newMaxRateAge";
        readonly type: "uint64";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "OwnershipTransferStarted";
    readonly inputs: readonly [{
        readonly name: "previousOwner";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "newOwner";
        readonly type: "address";
        readonly indexed: true;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "OwnershipTransferred";
    readonly inputs: readonly [{
        readonly name: "previousOwner";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "newOwner";
        readonly type: "address";
        readonly indexed: true;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "RedeemCancelledOnQueue";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
        readonly indexed: true;
    }, {
        readonly name: "engineShares";
        readonly type: "uint128";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "RedeemClaimed";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
        readonly indexed: true;
    }, {
        readonly name: "asset";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "amount";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "RedeemRequested";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
        readonly indexed: true;
    }, {
        readonly name: "assetOut";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "engineShares";
        readonly type: "uint128";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "Redeemed";
    readonly inputs: readonly [{
        readonly name: "receiver";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "engineShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "assets";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "RequestRecorded";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
        readonly indexed: true;
    }, {
        readonly name: "amountOfAssets";
        readonly type: "uint128";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "Settled";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "amount";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "newTotal";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "Unearmarked";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "amount";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "newTotal";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "VedaPeripheryUpdated";
    readonly inputs: readonly [{
        readonly name: "registryVersion";
        readonly type: "uint64";
        readonly indexed: true;
    }, {
        readonly name: "oldTeller";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "oldQueue";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "oldAccountant";
        readonly type: "address";
        readonly indexed: false;
    }, {
        readonly name: "newTeller";
        readonly type: "address";
        readonly indexed: false;
    }, {
        readonly name: "newQueue";
        readonly type: "address";
        readonly indexed: false;
    }, {
        readonly name: "newAccountant";
        readonly type: "address";
        readonly indexed: false;
    }, {
        readonly name: "validatedRate";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "WithdrewExact";
    readonly inputs: readonly [{
        readonly name: "receiver";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "assets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "engineSharesBurned";
        readonly type: "uint256";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "error";
    readonly name: "AlreadyInitialized";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "AssetsNotArrived";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
}, {
    readonly type: "error";
    readonly name: "CannotSweepEngineBacking";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ClaimNotClaimable";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
}, {
    readonly type: "error";
    readonly name: "ClaimNotOpen";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
}, {
    readonly type: "error";
    readonly name: "CreditExceedsBalance";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
    }, {
        readonly name: "have";
        readonly type: "uint256";
    }, {
        readonly name: "wantTotal";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "DepositsNotPaused";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "DuplicateRequest";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
}, {
    readonly type: "error";
    readonly name: "EarnVaultNotSet";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "EmptyMetadata";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "EngineSharesTooLarge";
    readonly inputs: readonly [{
        readonly name: "engineShares";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "InsufficientAssetsReceived";
    readonly inputs: readonly [{
        readonly name: "minimumAssets";
        readonly type: "uint256";
    }, {
        readonly name: "actualAssets";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "InvalidAsset";
    readonly inputs: readonly [{
        readonly name: "expected";
        readonly type: "address";
    }, {
        readonly name: "actual";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "InvalidMaxRateAge";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidRateTimestamp";
    readonly inputs: readonly [{
        readonly name: "updatedAt";
        readonly type: "uint256";
    }, {
        readonly name: "currentTime";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "InvalidVedaPeriphery";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "InvalidVedaPeripheryWiring";
    readonly inputs: readonly [{
        readonly name: "component";
        readonly type: "address";
    }, {
        readonly name: "expected";
        readonly type: "address";
    }, {
        readonly name: "actual";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "InvalidVedaRateBounds";
    readonly inputs: readonly [{
        readonly name: "minRate";
        readonly type: "uint256";
    }, {
        readonly name: "maxRate";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "InvalidVenueShareDecimals";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NoPublishedVedaPeriphery";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NoVenueSharesReceived";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotAuthorizedForwarder";
    readonly inputs: readonly [{
        readonly name: "caller";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "NotEarnVault";
    readonly inputs: readonly [{
        readonly name: "caller";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "NotSelf";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "OwnableInvalidOwner";
    readonly inputs: readonly [{
        readonly name: "owner";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "OwnableUnauthorizedAccount";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "QueueUnavailable";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "RateChangedWithinTransaction";
    readonly inputs: readonly [{
        readonly name: "expected";
        readonly type: "uint256";
    }, {
        readonly name: "actual";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "ReentrantCall";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "RegistryEngineMismatch";
    readonly inputs: readonly [{
        readonly name: "expected";
        readonly type: "address";
    }, {
        readonly name: "actual";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "RequestDetailsNotRecorded";
    readonly inputs: readonly [{
        readonly name: "requestId";
        readonly type: "bytes32";
    }];
}, {
    readonly type: "error";
    readonly name: "SolveUnderfunded";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
    }, {
        readonly name: "delivered";
        readonly type: "uint256";
    }, {
        readonly name: "required";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "StaleAccountantRate";
    readonly inputs: readonly [{
        readonly name: "updatedAt";
        readonly type: "uint256";
    }, {
        readonly name: "currentTime";
        readonly type: "uint256";
    }, {
        readonly name: "maxAge";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "SweepExceedsAvailableBalance";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "available";
        readonly type: "uint256";
    }, {
        readonly name: "requested";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "TransferFailed";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "UnexpectedAssetsReceived";
    readonly inputs: readonly [{
        readonly name: "expectedAssets";
        readonly type: "uint256";
    }, {
        readonly name: "actualAssets";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "UnexpectedVenueSharesBurned";
    readonly inputs: readonly [{
        readonly name: "expectedShares";
        readonly type: "uint256";
    }, {
        readonly name: "actualShares";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "UnsupportedAccountantFreshness";
    readonly inputs: readonly [{
        readonly name: "accountant";
        readonly type: "address";
    }];
}, {
    readonly type: "error";
    readonly name: "VedaRateOutOfBounds";
    readonly inputs: readonly [{
        readonly name: "rate";
        readonly type: "uint256";
    }, {
        readonly name: "minRate";
        readonly type: "uint256";
    }, {
        readonly name: "maxRate";
        readonly type: "uint256";
    }];
}, {
    readonly type: "error";
    readonly name: "ZeroAddress";
    readonly inputs: readonly [];
}];
export declare const earnRouter: readonly [{
    readonly type: "function";
    readonly name: "allowedZoneId";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint32";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "earnShare";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "earnVault";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "onWithdrawalReceived";
    readonly inputs: readonly [{
        readonly name: "sourceZoneId";
        readonly type: "uint32";
    }, {
        readonly name: "sourcePortal";
        readonly type: "address";
    }, {
        readonly name: "";
        readonly type: "bytes32";
    }, {
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint128";
    }, {
        readonly name: "callbackData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes4";
    }];
    readonly stateMutability: "nonpayable";
}, {
    readonly type: "function";
    readonly name: "privateAsset";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "reserveToken";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "supportsFlow";
    readonly inputs: readonly [{
        readonly name: "flow";
        readonly type: "uint8";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
    readonly stateMutability: "pure";
}, {
    readonly type: "function";
    readonly name: "tokenAuthority";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "transactionLimit";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "function";
    readonly name: "vaultAsset";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
}, {
    readonly type: "event";
    readonly name: "EarnDeposit";
    readonly inputs: readonly [{
        readonly name: "actionId";
        readonly type: "bytes32";
        readonly indexed: true;
    }, {
        readonly name: "earnVault";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "inputToken";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "inputAmount";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "vaultAssets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "earnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "zoneDepositHash";
        readonly type: "bytes32";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "event";
    readonly name: "EarnRedeem";
    readonly inputs: readonly [{
        readonly name: "actionId";
        readonly type: "bytes32";
        readonly indexed: true;
    }, {
        readonly name: "earnVault";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "outputToken";
        readonly type: "address";
        readonly indexed: true;
    }, {
        readonly name: "earnShares";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "vaultAssets";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "outputAmount";
        readonly type: "uint256";
        readonly indexed: false;
    }, {
        readonly name: "zoneDepositHash";
        readonly type: "bytes32";
        readonly indexed: false;
    }];
    readonly anonymous: false;
}, {
    readonly type: "error";
    readonly name: "AmountExceedsLimit";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "AmountOverflow";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "BadFlow";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InsufficientOutput";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidAuthority";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidEarnVault";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidPrivateAsset";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidReturnToken";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidRoutePair";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "InvalidSourcePortal";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "MismatchedTransactionLimit";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "NotZoneMessenger";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ReentrantCall";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ResidualBalance";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "TokenCallFailed";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "TokenCallFalse";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "WrongInputToken";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "WrongSourceZone";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ZeroAddress";
    readonly inputs: readonly [];
}, {
    readonly type: "error";
    readonly name: "ZeroAmount";
    readonly inputs: readonly [];
}];
export declare const earnRouterCallbackData: readonly [{
    readonly components: readonly [{
        readonly name: "flow";
        readonly type: "uint8";
    }, {
        readonly name: "minVaultAssets";
        readonly type: "uint128";
    }, {
        readonly name: "minEarnShares";
        readonly type: "uint128";
    }, {
        readonly name: "minOutputAmount";
        readonly type: "uint128";
    }, {
        readonly name: "actionId";
        readonly type: "bytes32";
    }, {
        readonly components: readonly [{
            readonly name: "keyIndex";
            readonly type: "uint256";
        }, {
            readonly components: readonly [{
                readonly name: "ephemeralPubkeyX";
                readonly type: "bytes32";
            }, {
                readonly name: "ephemeralPubkeyYParity";
                readonly type: "uint8";
            }, {
                readonly name: "ciphertext";
                readonly type: "bytes";
            }, {
                readonly name: "nonce";
                readonly type: "bytes12";
            }, {
                readonly name: "tag";
                readonly type: "bytes16";
            }];
            readonly name: "encrypted";
            readonly type: "tuple";
        }, {
            readonly name: "refundRecipient";
            readonly type: "address";
        }];
        readonly name: "zoneReturn";
        readonly type: "tuple";
    }];
    readonly name: "callbackData";
    readonly type: "tuple";
}];
//# sourceMappingURL=Abis.d.ts.map