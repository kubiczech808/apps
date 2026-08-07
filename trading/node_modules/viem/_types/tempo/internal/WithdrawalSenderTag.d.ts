import type { Address } from 'abitype';
import { type Hex } from 'ox';
/** Derives a withdrawal sender tag from its sender and transaction hash. @internal */
export declare function from(options: from.Options): Hex.Hex;
export declare namespace from {
    type Options = {
        sender: Address;
        transactionHash: Hex.Hex;
    };
}
//# sourceMappingURL=WithdrawalSenderTag.d.ts.map