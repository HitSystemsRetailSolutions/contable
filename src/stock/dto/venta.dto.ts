import { IsInt, IsNumber, IsPositive } from 'class-validator';

export class VentaDto {
  @IsInt()
  CodiArticle!: number;

  @IsNumber()
  Quantitat!: number;

  @IsNumber()
  import!: number;
}