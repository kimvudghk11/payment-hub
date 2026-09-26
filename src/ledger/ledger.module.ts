import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerAccount } from './domain/ledger-account.entity';
import { LedgerEntry } from './domain/ledger-entry.entity';
import { LedgerTransaction } from './domain/ledger-transaction.entity';
import { LedgerService } from './ledger.service';

@Module({
  imports: [TypeOrmModule.forFeature([LedgerAccount, LedgerTransaction, LedgerEntry])],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
