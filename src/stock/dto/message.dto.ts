import {
    IsInt,
    IsOptional,
    IsString,
    IsArray,
    ValidateNested,
  } from 'class-validator';
  import { Type } from 'class-transformer';
  import { VentaDto } from './venta.dto';
  
  export class MessageDto {
    @IsInt()
    Llicencia!: number;
  
    @IsString()
    Empresa!: string;
  
    @IsString()
    @IsOptional()
    Tipus?: 'ObreCaixa' | 'Venta' | 'Encarrec';
  
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => VentaDto)
    @IsOptional()
    Articles?: VentaDto[];
    @IsOptional()
    CaixaDataInici?: string;
  }
  