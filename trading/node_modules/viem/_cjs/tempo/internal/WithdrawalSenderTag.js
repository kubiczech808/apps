"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.from = from;
const ox_1 = require("ox");
function from(options) {
    const { sender, transactionHash } = options;
    return ox_1.Hash.keccak256(ox_1.AbiParameters.encodePacked(['address', 'bytes32'], [sender, transactionHash]));
}
//# sourceMappingURL=WithdrawalSenderTag.js.map