import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const studio = [
    { weekOfYear: 1,  periodText: "28 Aralık - 4 Ocak",   taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 2,  periodText: "4 Ocak - 11 Ocak",     taksit12Cents: 1000000, taksit6Cents:  900000, pesinCents:  800000 },
    { weekOfYear: 3,  periodText: "11 Ocak - 18 Ocak",    taksit12Cents: 1000000, taksit6Cents:  900000, pesinCents:  800000 },
    { weekOfYear: 4,  periodText: "18 Ocak - 25 Ocak",    taksit12Cents: 1000000, taksit6Cents:  900000, pesinCents:  800000 },
    { weekOfYear: 5,  periodText: "25 Ocak - 1 Şubat",    taksit12Cents:  700000, taksit6Cents:  600000, pesinCents:  500000 },
    { weekOfYear: 6,  periodText: "1 Şubat - 8 Şubat",    taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 7,  periodText: "8 Şubat - 15 Şubat",   taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 8,  periodText: "15 Şubat - 22 Şubat",  taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 9,  periodText: "22 Şubat - 1 Mart",    taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 10, periodText: "1 Mart - 8 Mart",      taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 11, periodText: "8 Mart - 15 Mart",     taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 12, periodText: "15 Mart - 22 Mart",    taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 13, periodText: "22 Mart - 29 Mart",    taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 14, periodText: "29 Mart - 5 Nisan",    taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 15, periodText: "5 Nisan - 12 Nisan",   taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 16, periodText: "12 Nisan - 19 Nisan",  taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 17, periodText: "19 Nisan - 26 Nisan",  taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 18, periodText: "26 Nisan - 3 Mayıs",   taksit12Cents: 1000000, taksit6Cents:  900000, pesinCents:  800000 },
    { weekOfYear: 19, periodText: "3 Mayıs - 10 Mayıs",   taksit12Cents: 1000000, taksit6Cents:  900000, pesinCents:  800000 },
    { weekOfYear: 20, periodText: "10 Mayıs - 17 Mayıs",  taksit12Cents: 1000000, taksit6Cents:  900000, pesinCents:  800000 },
    { weekOfYear: 21, periodText: "17 Mayıs - 24 Mayıs",  taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 22, periodText: "24 Mayıs - 31 Mayıs",  taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 23, periodText: "31 Mayıs - 7 Haziran", taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 24, periodText: "7 Haziran - 14 Haziran",taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 25, periodText: "14 Haziran - 21 Haziran",taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 26, periodText: "21 Haziran - 28 Haziran",taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 27, periodText: "28 Haziran - 5 Temmuz", taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 28, periodText: "5 Temmuz - 12 Temmuz",  taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 29, periodText: "12 Temmuz - 19 Temmuz", taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 30, periodText: "19 Temmuz - 26 Temmuz", taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 31, periodText: "26 Temmuz - 2 Ağustos", taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 32, periodText: "2 Ağustos - 9 Ağustos", taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 33, periodText: "9 Ağustos - 16 Ağustos",taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 34, periodText: "16 Ağustos - 23 Ağustos",taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 35, periodText: "23 Ağustos - 30 Ağustos",taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 36, periodText: "30 Ağustos - 6 Eylül",  taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 37, periodText: "6 Eylül - 13 Eylül",    taksit12Cents: 1200000, taksit6Cents: 1100000, pesinCents: 1000000 },
    { weekOfYear: 38, periodText: "13 Eylül - 20 Eylül",   taksit12Cents: 1100000, taksit6Cents: 1000000, pesinCents:  900000 },
    { weekOfYear: 39, periodText: "20 Eylül - 27 Eylül",   taksit12Cents: 1000000, taksit6Cents:  900000, pesinCents:  800000 },
    { weekOfYear: 40, periodText: "27 Eylül - 4 Ekim",      taksit12Cents: 1000000, taksit6Cents:  900000, pesinCents:  800000 },
    { weekOfYear: 41, periodText: "4 Ekim - 11 Ekim",       taksit12Cents: 1000000, taksit6Cents:  900000, pesinCents:  800000 },
    { weekOfYear: 42, periodText: "11 Ekim - 18 Ekim",      taksit12Cents: 1000000, taksit6Cents:  900000, pesinCents:  800000 },
    { weekOfYear: 43, periodText: "18 Ekim - 25 Ekim",      taksit12Cents: 1000000, taksit6Cents:  900000, pesinCents:  800000 },
    { weekOfYear: 44, periodText: "25 Ekim - 1 Kasım",      taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 45, periodText: "1 Kasım - 8 Kasım",      taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 46, periodText: "8 Kasım - 15 Kasım",     taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 47, periodText: "15 Kasım - 22 Kasım",    taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 48, periodText: "22 Kasım - 29 Kasım",    taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 49, periodText: "29 Kasım - 6 Aralık",    taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 50, periodText: "6 Aralık - 13 Aralık",   taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 51, periodText: "13 Aralık - 20 Aralık",  taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
    { weekOfYear: 52, periodText: "20 Aralık - 27 Aralık",  taksit12Cents:  900000, taksit6Cents:  800000, pesinCents:  700000 },
  ];

    // ONE_PLUS_ONE prices (GBP pence) + periodText
  const onePlusOne = [
    { weekOfYear: 1,  periodText: "28 Aralık - 4 Ocak",   taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 2,  periodText: "4 Ocak - 11 Ocak",     taksit12Cents: 1200000, taksit6Cents: 1080000, pesinCents:  960000 },
    { weekOfYear: 3,  periodText: "11 Ocak - 18 Ocak",    taksit12Cents: 1200000, taksit6Cents: 1080000, pesinCents:  960000 },
    { weekOfYear: 4,  periodText: "18 Ocak - 25 Ocak",    taksit12Cents: 1200000, taksit6Cents: 1080000, pesinCents:  960000 },
    { weekOfYear: 5,  periodText: "25 Ocak - 1 Şubat",    taksit12Cents:  840000, taksit6Cents:  720000, pesinCents:  600000 },
    { weekOfYear: 6,  periodText: "1 Şubat - 8 Şubat",    taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 7,  periodText: "8 Şubat - 15 Şubat",   taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 8,  periodText: "15 Şubat - 22 Şubat",  taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 9,  periodText: "22 Şubat - 1 Mart",    taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 10, periodText: "1 Mart - 8 Mart",      taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 11, periodText: "8 Mart - 15 Mart",     taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 12, periodText: "15 Mart - 22 Mart",    taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 13, periodText: "22 Mart - 29 Mart",    taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 14, periodText: "29 Mart - 5 Nisan",    taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 15, periodText: "5 Nisan - 12 Nisan",   taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 16, periodText: "12 Nisan - 19 Nisan",  taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 17, periodText: "19 Nisan - 26 Nisan",  taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 18, periodText: "26 Nisan - 3 Mayıs",   taksit12Cents: 1200000, taksit6Cents: 1080000, pesinCents:  960000 },
    { weekOfYear: 19, periodText: "3 Mayıs - 10 Mayıs",   taksit12Cents: 1200000, taksit6Cents: 1080000, pesinCents:  960000 },
    { weekOfYear: 20, periodText: "10 Mayıs - 17 Mayıs",  taksit12Cents: 1200000, taksit6Cents: 1080000, pesinCents:  960000 },
    { weekOfYear: 21, periodText: "17 Mayıs - 24 Mayıs",  taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 22, periodText: "24 Mayıs - 31 Mayıs",  taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 23, periodText: "31 Mayıs - 7 Haziran", taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 24, periodText: "7 Haziran - 14 Haziran", taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 25, periodText: "14 Haziran - 21 Haziran", taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 26, periodText: "21 Haziran - 28 Haziran", taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 27, periodText: "28 Haziran - 5 Temmuz", taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 28, periodText: "5 Temmuz - 12 Temmuz",  taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 29, periodText: "12 Temmuz - 19 Temmuz", taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 30, periodText: "19 Temmuz - 26 Temmuz", taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 31, periodText: "26 Temmuz - 2 Ağustos", taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 32, periodText: "2 Ağustos - 9 Ağustos", taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 33, periodText: "9 Ağustos - 16 Ağustos", taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 34, periodText: "16 Ağustos - 23 Ağustos", taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 35, periodText: "23 Ağustos - 30 Ağustos", taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 36, periodText: "30 Ağustos - 6 Eylül",  taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 37, periodText: "6 Eylül - 13 Eylül",    taksit12Cents: 1440000, taksit6Cents: 1320000, pesinCents: 1200000 },
    { weekOfYear: 38, periodText: "13 Eylül - 20 Eylül",   taksit12Cents: 1320000, taksit6Cents: 1200000, pesinCents: 1080000 },
    { weekOfYear: 39, periodText: "20 Eylül - 27 Eylül",   taksit12Cents: 1200000, taksit6Cents: 1080000, pesinCents:  960000 },
    { weekOfYear: 40, periodText: "27 Eylül - 4 Ekim",     taksit12Cents: 1200000, taksit6Cents: 1080000, pesinCents:  960000 },
    { weekOfYear: 41, periodText: "4 Ekim - 11 Ekim",      taksit12Cents: 1200000, taksit6Cents: 1080000, pesinCents:  960000 },
    { weekOfYear: 42, periodText: "11 Ekim - 18 Ekim",     taksit12Cents: 1200000, taksit6Cents: 1080000, pesinCents:  960000 },
    { weekOfYear: 43, periodText: "18 Ekim - 25 Ekim",     taksit12Cents: 1200000, taksit6Cents: 1080000, pesinCents:  960000 },
    { weekOfYear: 44, periodText: "25 Ekim - 1 Kasım",     taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 45, periodText: "1 Kasım - 8 Kasım",     taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 46, periodText: "8 Kasım - 15 Kasım",    taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 47, periodText: "15 Kasım - 22 Kasım",   taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 48, periodText: "22 Kasım - 29 Kasım",   taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 49, periodText: "29 Kasım - 6 Aralık",   taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 50, periodText: "6 Aralık - 13 Aralık",  taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 51, periodText: "13 Aralık - 20 Aralık", taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
    { weekOfYear: 52, periodText: "20 Aralık - 27 Aralık", taksit12Cents: 1080000, taksit6Cents:  960000, pesinCents:  840000 },
  ];


    // TWO_PLUS_ONE prices (GBP pence) + periodText
  const twoPlusOne = [
    { weekOfYear: 1,  periodText: "28 Aralık - 4 Ocak",   taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 2,  periodText: "4 Ocak - 11 Ocak",     taksit12Cents: 1440000, taksit6Cents: 1296000, pesinCents: 1152000 },
    { weekOfYear: 3,  periodText: "11 Ocak - 18 Ocak",    taksit12Cents: 1440000, taksit6Cents: 1296000, pesinCents: 1152000 },
    { weekOfYear: 4,  periodText: "18 Ocak - 25 Ocak",    taksit12Cents: 1440000, taksit6Cents: 1296000, pesinCents: 1152000 },
    { weekOfYear: 5,  periodText: "25 Ocak - 1 Şubat",    taksit12Cents: 1008000, taksit6Cents:  864000, pesinCents:  720000 },
    { weekOfYear: 6,  periodText: "1 Şubat - 8 Şubat",    taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 7,  periodText: "8 Şubat - 15 Şubat",   taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 8,  periodText: "15 Şubat - 22 Şubat",  taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 9,  periodText: "22 Şubat - 1 Mart",    taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 10, periodText: "1 Mart - 8 Mart",      taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 11, periodText: "8 Mart - 15 Mart",     taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 12, periodText: "15 Mart - 22 Mart",    taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 13, periodText: "22 Mart - 29 Mart",    taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 14, periodText: "29 Mart - 5 Nisan",    taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 15, periodText: "5 Nisan - 12 Nisan",   taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 16, periodText: "12 Nisan - 19 Nisan",  taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 17, periodText: "19 Nisan - 26 Nisan",  taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 18, periodText: "26 Nisan - 3 Mayıs",   taksit12Cents: 1440000, taksit6Cents: 1296000, pesinCents: 1152000 },
    { weekOfYear: 19, periodText: "3 Mayıs - 10 Mayıs",   taksit12Cents: 1440000, taksit6Cents: 1296000, pesinCents: 1152000 },
    { weekOfYear: 20, periodText: "10 Mayıs - 17 Mayıs",  taksit12Cents: 1440000, taksit6Cents: 1296000, pesinCents: 1152000 },
    { weekOfYear: 21, periodText: "17 Mayıs - 24 Mayıs",  taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 22, periodText: "24 Mayıs - 31 Mayıs",  taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 23, periodText: "31 Mayıs - 7 Haziran", taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 24, periodText: "7 Haziran - 14 Haziran", taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 25, periodText: "14 Haziran - 21 Haziran", taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 26, periodText: "21 Haziran - 28 Haziran", taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 27, periodText: "28 Haziran - 5 Temmuz", taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 28, periodText: "5 Temmuz - 12 Temmuz",  taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 29, periodText: "12 Temmuz - 19 Temmuz", taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 30, periodText: "19 Temmuz - 26 Temmuz", taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 31, periodText: "26 Temmuz - 2 Ağustos", taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 32, periodText: "2 Ağustos - 9 Ağustos", taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 33, periodText: "9 Ağustos - 16 Ağustos", taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 34, periodText: "16 Ağustos - 23 Ağustos", taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 35, periodText: "23 Ağustos - 30 Ağustos", taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 36, periodText: "30 Ağustos - 6 Eylül",  taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 37, periodText: "6 Eylül - 13 Eylül",    taksit12Cents: 1728000, taksit6Cents: 1584000, pesinCents: 1440000 },
    { weekOfYear: 38, periodText: "13 Eylül - 20 Eylül",   taksit12Cents: 1584000, taksit6Cents: 1440000, pesinCents: 1296000 },
    { weekOfYear: 39, periodText: "20 Eylül - 27 Eylül",   taksit12Cents: 1440000, taksit6Cents: 1296000, pesinCents: 1152000 },
    { weekOfYear: 40, periodText: "27 Eylül - 4 Ekim",     taksit12Cents: 1440000, taksit6Cents: 1296000, pesinCents: 1152000 },
    { weekOfYear: 41, periodText: "4 Ekim - 11 Ekim",      taksit12Cents: 1440000, taksit6Cents: 1296000, pesinCents: 1152000 },
    { weekOfYear: 42, periodText: "11 Ekim - 18 Ekim",     taksit12Cents: 1440000, taksit6Cents: 1296000, pesinCents: 1152000 },
    { weekOfYear: 43, periodText: "18 Ekim - 25 Ekim",     taksit12Cents: 1440000, taksit6Cents: 1296000, pesinCents: 1152000 },
    { weekOfYear: 44, periodText: "25 Ekim - 1 Kasım",     taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 45, periodText: "1 Kasım - 8 Kasım",     taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 46, periodText: "8 Kasım - 15 Kasım",    taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 47, periodText: "15 Kasım - 22 Kasım",   taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 48, periodText: "22 Kasım - 29 Kasım",   taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 49, periodText: "29 Kasım - 6 Aralık",   taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 50, periodText: "6 Aralık - 13 Aralık",  taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 51, periodText: "13 Aralık - 20 Aralık", taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
    { weekOfYear: 52, periodText: "20 Aralık - 27 Aralık", taksit12Cents: 1296000, taksit6Cents: 1152000, pesinCents: 1008000 },
  ];

  for (const r of twoPlusOne) {
    await prisma.weekPrice.upsert({
      where: { unitType_weekOfYear: { unitType: "TWO_PLUS_ONE", weekOfYear: r.weekOfYear } },
      update: {
        periodText: r.periodText,
        pesinCents: r.pesinCents,
        taksit6Cents: r.taksit6Cents,
        taksit12Cents: r.taksit12Cents,
      },
      create: {
        unitType: "TWO_PLUS_ONE",
        weekOfYear: r.weekOfYear,
        periodText: r.periodText,
        pesinCents: r.pesinCents,
        taksit6Cents: r.taksit6Cents,
        taksit12Cents: r.taksit12Cents,
      },
    });
  }

  console.log("✅ TWO_PLUS_ONE week prices upserted:", twoPlusOne.length);

  for (const r of onePlusOne) {
    await prisma.weekPrice.upsert({
      where: { unitType_weekOfYear: { unitType: "ONE_PLUS_ONE", weekOfYear: r.weekOfYear } },
      update: {
        periodText: r.periodText,
        pesinCents: r.pesinCents,
        taksit6Cents: r.taksit6Cents,
        taksit12Cents: r.taksit12Cents,
      },
      create: {
        unitType: "ONE_PLUS_ONE",
        weekOfYear: r.weekOfYear,
        periodText: r.periodText,
        pesinCents: r.pesinCents,
        taksit6Cents: r.taksit6Cents,
        taksit12Cents: r.taksit12Cents,
      },
    });
  }

  console.log("✅ ONE_PLUS_ONE week prices upserted:", onePlusOne.length);

  for (const r of studio) {
    await prisma.weekPrice.upsert({
      where: { unitType_weekOfYear: { unitType: "STUDIO", weekOfYear: r.weekOfYear } },
      update: {
        periodText: r.periodText,
        pesinCents: r.pesinCents,
        taksit6Cents: r.taksit6Cents,
        taksit12Cents: r.taksit12Cents,
      },
      create: {
        unitType: "STUDIO",
        weekOfYear: r.weekOfYear,
        periodText: r.periodText,
        pesinCents: r.pesinCents,
        taksit6Cents: r.taksit6Cents,
        taksit12Cents: r.taksit12Cents,
      },
    });
  }

  console.log("✅ STUDIO week prices upserted:", studio.length);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });